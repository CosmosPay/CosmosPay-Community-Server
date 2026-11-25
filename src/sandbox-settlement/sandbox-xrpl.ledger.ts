import { randomInt } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentDeposit, SandboxPayout } from '@generated/prisma/client';
import { formatUnits } from '@/chains/units';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig } from '@/config/configuration';
import type { PaymentNetwork } from '@/payment-intents/payment-networks';
import { treasurySubkey } from '@/sandbox-settlement/sandbox-hd';
import type {
  SandboxDepositTarget,
  SandboxLedger,
  SandboxTransfer,
  SandboxTxOutcome,
  SignedSandboxTransfer,
} from '@/sandbox-settlement/sandbox-ledger';
import { SandboxXrplClient } from '@/sandbox-settlement/sandbox-xrpl.client';
import {
  iouValueToUnits,
  signXrplTransaction,
  type XrplCurrency,
  type XrplTransaction,
  xrplAddressOfSecret,
  xrplLastLedgerSequence,
} from '@/sandbox-settlement/sandbox-xrpl.codec';
import {
  XRPL_ACCOUNT_TX_MAX_PAGES,
  XRPL_ACCOUNT_TX_PAGE,
  XRPL_DEPOSIT_CLOCK_MARGIN_MS,
  XRPL_DEPOSIT_LOCATOR_PREFIX,
  XRPL_MAX_FEE_DROPS,
  XRPL_PAYMENT_FLAGS,
  XRPL_TREASURY_TRUST_LIMIT,
  XRPL_TRUST_SET_FLAGS,
  XRPL_TRUST_SET_POLL_MS,
  XRPL_TRUST_SET_WAIT_MS,
  XRPL_TX_VALIDITY_LEDGERS,
} from '@/sandbox-settlement/sandbox-xrpl.constants';

/**
 * The sandbox on the XRP Ledger testnet. The treasury (an ed25519 key derived
 * from `SANDBOX_TREASURY_PRIVATE_KEY` for this network) is also where payers
 * deposit: each payment gets a random destination tag, and what arrived is the
 * sum of validated test-USDC payments to the treasury with that tag. Payouts
 * and refunds are Payments from the treasury, valid for
 * `XRPL_TX_VALIDITY_LEDGERS` ledgers, so one that never validated is provably
 * dead and final as failed.
 */
@Injectable()
export class SandboxXrplLedger implements SandboxLedger {
  private readonly logger = new Logger(SandboxXrplLedger.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly client: SandboxXrplClient,
  ) {}

  newDeposit(network: PaymentNetwork): SandboxDepositTarget {
    // 1..2^32-1: a zero tag reads as "no tag" in some wallets.
    const tag = randomInt(1, 2 ** 32);
    return {
      address: this.treasuryAddress(network),
      memo: String(tag),
      locator: `${XRPL_DEPOSIT_LOCATOR_PREFIX}${tag}`,
    };
  }

  treasuryAddress(network: PaymentNetwork): string {
    return xrplAddressOfSecret(this.treasurySecret(network));
  }

  /**
   * Validated test-USDC payments to the treasury carrying the deposit's tag,
   * by what they DELIVERED (a partial payment delivers less than its Amount),
   * from the newest back to the first that closed before the deposit opened.
   */
  async received(deposit: PaymentDeposit): Promise<bigint> {
    const network = deposit.originChain as PaymentNetwork;
    const tag = /^\d{1,10}$/.test(deposit.depositMemo ?? '')
      ? Number(deposit.depositMemo)
      : null;
    if (tag === null) return 0n;
    const treasury = deposit.depositAddress;
    const usdc = this.usdc(network);
    const since = deposit.createdAt.getTime() - XRPL_DEPOSIT_CLOCK_MARGIN_MS;
    const decimals = deposit.originDecimals;
    let total = 0n;
    let marker: unknown;
    for (let page = 0; page < XRPL_ACCOUNT_TX_MAX_PAGES; page++) {
      const answer = await this.client.accountTx(
        network,
        treasury,
        XRPL_ACCOUNT_TX_PAGE,
        marker,
      );
      for (const entry of answer.transactions) {
        const closed = Date.parse(entry.close_time_iso ?? '');
        if (Number.isFinite(closed) && closed < since) return total;
        const tx = entry.tx_json ?? {};
        if (
          entry.validated !== true ||
          tx.TransactionType !== 'Payment' ||
          tx.Destination !== treasury ||
          tx.Account === treasury ||
          tx.DestinationTag !== tag ||
          entry.meta?.TransactionResult !== 'tesSUCCESS'
        ) {
          continue;
        }
        const delivered = entry.meta.delivered_amount as
          | { currency?: string; issuer?: string; value?: string }
          | string
          | undefined;
        if (
          typeof delivered === 'object' &&
          delivered.issuer === usdc.issuer &&
          delivered.currency?.toUpperCase() === usdc.currency &&
          typeof delivered.value === 'string'
        ) {
          const units = iouValueToUnits(delivered.value, decimals);
          if (units > 0n) total += units;
        }
      }
      if (answer.marker === undefined) return total;
      marker = answer.marker;
    }
    return total;
  }

  async blocker(transfer: SandboxTransfer): Promise<string | null> {
    const { network, recipient, amount } = transfer;
    const treasury = this.treasuryAddress(network);
    const usdc = this.usdc(network);
    const decimals = this.client.network(network).stablecoin.decimals;
    const account = await this.client.account(network, treasury);
    if (!account) {
      return `the treasury ${treasury} does not exist on the XRP Ledger testnet yet: fund it with test XRP`;
    }
    const { base, increment } = await this.client.reserves(network);
    const reserve = base + increment * BigInt(account.ownerCount);
    if (account.balance < reserve + XRPL_MAX_FEE_DROPS) {
      return `the treasury ${treasury} holds ${account.balance} drops, below its reserve and fee: fund it with test XRP`;
    }
    const line = await this.client.trustLine(
      network,
      treasury,
      usdc.issuer,
      usdc.currency,
    );
    if (!line) {
      return `the treasury ${treasury} has no trustline for the test USDC: run npm run sandbox:prepare`;
    }
    const held = iouValueToUnits(line.balance, decimals);
    if (held < amount) {
      return `the treasury ${treasury} holds ${held} of the test USDC, below ${amount}: fund it`;
    }
    return this.recipientBlocker(network, recipient, amount, decimals);
  }

  /** Why `recipient` cannot be paid `amount` of the test USDC; null when it can. */
  private async recipientBlocker(
    network: PaymentNetwork,
    recipient: string,
    amount: bigint,
    decimals: number,
  ): Promise<string | null> {
    const usdc = this.usdc(network);
    const account = await this.client.account(network, recipient);
    if (!account) {
      return `the recipient ${recipient} does not exist on the XRP Ledger testnet`;
    }
    if (account.requireDestinationTag) {
      return `the recipient ${recipient} requires a destination tag, which a sandbox payout does not carry`;
    }
    if (account.depositAuth) {
      return `the recipient ${recipient} accepts payments only from accounts it authorized`;
    }
    // The issuer takes its own currency back without a trustline.
    if (recipient === usdc.issuer) return null;
    const line = await this.client.trustLine(
      network,
      recipient,
      usdc.issuer,
      usdc.currency,
    );
    if (!line) {
      return `the recipient ${recipient} has no trustline for the test USDC (issuer ${usdc.issuer}): only that account can add it`;
    }
    if (line.freezePeer) {
      return `the recipient ${recipient}'s test USDC trustline is frozen by its issuer`;
    }
    const room =
      iouValueToUnits(line.limit, decimals) -
      iouValueToUnits(line.balance, decimals);
    if (room < amount) {
      return `the recipient ${recipient}'s test USDC trustline limit leaves room for ${room}, below ${amount}: only that account can raise it`;
    }
    return null;
  }

  async sign(transfer: SandboxTransfer): Promise<SignedSandboxTransfer> {
    const { network, recipient, amount } = transfer;
    const signed = await this.signFromTreasury(
      network,
      (sequence, fee, last) => ({
        TransactionType: 'Payment',
        Flags: XRPL_PAYMENT_FLAGS,
        Sequence: sequence,
        LastLedgerSequence: last,
        Fee: fee,
        Account: this.treasuryAddress(network),
        Destination: recipient,
        Amount: {
          ...this.usdc(network),
          units: amount,
          decimals: this.client.network(network).stablecoin.decimals,
        },
      }),
    );
    return {
      hash: signed.hash,
      raw: signed.blob,
      nonce: String(signed.sequence),
    };
  }

  /**
   * Submits signed bytes. A blob the ledger already applied, queued or saw
   * expire (`tefPAST_SEQ`, `tefALREADY`, `tefMAX_LEDGER`, a `tel` local
   * answer) is not an error: `follow` reads its outcome from the ledger. Only
   * a malformed transaction (`tem`) is, since sending it again changes nothing.
   */
  async broadcast(network: PaymentNetwork, raw: string): Promise<void> {
    const { engineResult, message } = await this.client.submit(network, raw);
    if (engineResult.startsWith('tem')) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `${this.client.network(network).testnetName} refused the transaction: ${engineResult} ${message}`.trim(),
      );
    }
  }

  /**
   * Validated with tesSUCCESS: succeeded. Validated with a tec code: failed
   * (the fee was spent, nothing moved). Not found in any ledger up to its
   * LastLedgerSequence, all of them validated: failed, it can never execute.
   * Otherwise the same bytes are submitted again.
   */
  async follow(row: SandboxPayout): Promise<SandboxTxOutcome> {
    const network = row.network as PaymentNetwork;
    const last = xrplLastLedgerSequence(row.raw);
    const lookup = await this.client.tx(
      network,
      row.txHash,
      last === null
        ? undefined
        : {
            minLedger: Math.max(1, last - XRPL_TX_VALIDITY_LEDGERS),
            maxLedger: last,
          },
    );
    if (lookup.found && lookup.validated) {
      return lookup.result === 'tesSUCCESS' ? 'succeeded' : 'failed';
    }
    if (!lookup.found && lookup.searchedAll) return 'failed';
    await this.broadcast(network, row.raw);
    return 'pending';
  }

  explorerTx(network: PaymentNetwork, hash: string): string {
    return `${this.client.network(network).explorerTx}${hash}`;
  }

  /** The test USDC trustline, set once the treasury holds enough XRP for its reserve. */
  async prepareTreasury(network: PaymentNetwork): Promise<string[]> {
    const treasury = this.treasuryAddress(network);
    const usdc = this.usdc(network);
    const decimals = this.client.network(network).stablecoin.decimals;
    const account = await this.client.account(network, treasury);
    if (!account) {
      throw new Error(
        `treasury ${treasury} does not exist yet: fund it with test XRP first`,
      );
    }
    const line = await this.client.trustLine(
      network,
      treasury,
      usdc.issuer,
      usdc.currency,
    );
    if (line) {
      return [
        `treasury ${treasury}: test USDC trustline in place (balance ${line.balance}, limit ${line.limit})`,
      ];
    }
    const { base, increment } = await this.client.reserves(network);
    const needed =
      base + increment * BigInt(account.ownerCount + 1) + XRPL_MAX_FEE_DROPS;
    if (account.balance < needed) {
      throw new Error(
        `treasury ${treasury} holds ${account.balance} drops; the trustline needs ${needed}: fund it with test XRP`,
      );
    }
    const limit = iouValueToUnits(XRPL_TREASURY_TRUST_LIMIT, decimals);
    const signed = await this.signFromTreasury(
      network,
      (sequence, fee, last) => ({
        TransactionType: 'TrustSet',
        Flags: XRPL_TRUST_SET_FLAGS,
        Sequence: sequence,
        LastLedgerSequence: last,
        Fee: fee,
        Account: treasury,
        LimitAmount: { ...usdc, units: limit, decimals },
      }),
    );
    await this.broadcast(network, signed.blob);
    const deadline = Date.now() + XRPL_TRUST_SET_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, XRPL_TRUST_SET_POLL_MS),
      );
      const lookup = await this.client.tx(network, signed.hash);
      if (lookup.found && lookup.validated) {
        if (lookup.result !== 'tesSUCCESS') {
          throw new Error(
            `TrustSet ${signed.hash} failed on the ledger: ${lookup.result}`,
          );
        }
        return [
          `treasury ${treasury}: test USDC trustline set (limit ${formatUnits(limit, decimals)}, tx ${signed.hash})`,
        ];
      }
    }
    return [
      `treasury ${treasury}: TrustSet ${signed.hash} sent, not validated yet; run again to check`,
    ];
  }

  async treasuryReport(network: PaymentNetwork): Promise<string> {
    const treasury = this.treasuryAddress(network);
    const usdc = this.usdc(network);
    const account = await this.client.account(network, treasury);
    if (!account)
      return `treasury ${treasury} not activated (fund it with test XRP)`;
    const line = await this.client.trustLine(
      network,
      treasury,
      usdc.issuer,
      usdc.currency,
    );
    const stable = line
      ? `USDC ${line.balance}`
      : 'USDC no trustline (run sandbox:prepare)';
    return `treasury ${treasury} XRP ${account.balance} drops, ${stable}`;
  }

  /**
   * Signs what `build` makes from the treasury's next sequence, the fee to
   * enter the open ledger (capped) and a LastLedgerSequence
   * `XRPL_TX_VALIDITY_LEDGERS` past the open ledger.
   */
  private async signFromTreasury(
    network: PaymentNetwork,
    build: (sequence: number, fee: bigint, last: number) => XrplTransaction,
  ): Promise<{ blob: string; hash: string; sequence: number }> {
    const treasury = this.treasuryAddress(network);
    const [account, fees] = await Promise.all([
      this.client.account(network, treasury, 'current'),
      this.client.fee(network),
    ]);
    if (!account) {
      throw new Error(`XRP Ledger treasury ${treasury} does not exist`);
    }
    const wanted =
      fees.openLedgerFee > fees.baseFee ? fees.openLedgerFee : fees.baseFee;
    if (wanted > XRPL_MAX_FEE_DROPS) {
      this.logger.warn(
        `XRP Ledger open-ledger fee ${wanted} drops is above the cap; paying ${XRPL_MAX_FEE_DROPS}`,
      );
    }
    const fee = wanted > XRPL_MAX_FEE_DROPS ? XRPL_MAX_FEE_DROPS : wanted;
    const tx = build(
      account.sequence,
      fee,
      fees.currentLedger + XRPL_TX_VALIDITY_LEDGERS,
    );
    const signed = signXrplTransaction(tx, this.treasurySecret(network));
    return { ...signed, sequence: account.sequence };
  }

  private usdc(network: PaymentNetwork): XrplCurrency {
    const entry = this.client.network(network);
    return {
      currency: entry.currency.toUpperCase(),
      issuer: entry.stablecoin.contract ?? '',
    };
  }

  private treasurySecret(network: PaymentNetwork): Uint8Array {
    const hex = this.config.get('sandbox', { infer: true }).treasuryPrivateKey;
    if (!hex) throw new Error('SANDBOX_TREASURY_PRIVATE_KEY is not set');
    return treasurySubkey(hex, network);
  }
}
