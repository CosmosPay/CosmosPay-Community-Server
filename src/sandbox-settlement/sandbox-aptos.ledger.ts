import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentDeposit, SandboxPayout } from '@generated/prisma/client';
import type { AppConfig } from '@/config/configuration';
import type { PaymentNetwork } from '@/payment-intents/payment-networks';
import { SandboxAptosClient } from '@/sandbox-settlement/sandbox-aptos.client';
import {
  aptosAddressOfSecret,
  aptosFaTransferRaw,
  aptosLongAddress,
  decodeAptosSignedTransaction,
  signAptosTransaction,
} from '@/sandbox-settlement/sandbox-aptos.codec';
import {
  APTOS_OCTAS_PER_APT,
  SANDBOX_APTOS_COIN_TYPE,
  SANDBOX_APTOS_EXPIRATION_SECONDS,
  SANDBOX_APTOS_EXPLORER_QUERY,
  SANDBOX_APTOS_MAX_GAS_AMOUNT,
} from '@/sandbox-settlement/sandbox-aptos.constants';
import {
  depositPath,
  ed25519DepositSecret,
  newDepositIndexes,
  treasurySubkey,
} from '@/sandbox-settlement/sandbox-hd';
import type {
  SandboxDepositTarget,
  SandboxLedger,
  SandboxTransfer,
  SandboxTxOutcome,
  SignedSandboxTransfer,
} from '@/sandbox-settlement/sandbox-ledger';

/**
 * The sandbox on the Aptos test network. A deposit is an ed25519 account of
 * its own (SLIP-0010 at `m/44'/637'/7007'/a'/b'`): receiving a fungible asset
 * needs no account on-chain, its primary store is created by the deposit.
 * What arrived is that store's test-USDC balance. The treasury is an ed25519
 * key derived from `SANDBOX_TREASURY_PRIVATE_KEY` for this network and pays
 * with `0x1::primary_fungible_store::transfer` (gas in APT).
 *
 * A signed transfer carries an expiration. While it is not committed its bytes
 * are submitted again; once expired and provably unexecuted (its sequence
 * number never consumed, or consumed by another transaction) it is final as
 * failed. It is never signed a second time.
 */
@Injectable()
export class SandboxAptosLedger implements SandboxLedger {
  private readonly logger = new Logger(SandboxAptosLedger.name);
  /**
   * The next sequence number this process signs per sender. The account's
   * on-chain number does not count transfers still in the mempool, so two
   * payouts in one tick would otherwise share one and the second would never
   * execute. Ticks run under one lock across replicas, seconds apart, so a
   * replica that takes over reads a number the chain has caught up with.
   */
  private readonly nextSequence = new Map<string, bigint>();

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly client: SandboxAptosClient,
  ) {}

  newDeposit(): SandboxDepositTarget {
    const indexes = newDepositIndexes();
    const seed = this.config.get('sandbox', { infer: true }).depositSeed;
    return {
      address: aptosAddressOfSecret(
        ed25519DepositSecret(seed, SANDBOX_APTOS_COIN_TYPE, indexes),
      ),
      memo: null,
      locator: depositPath(indexes, SANDBOX_APTOS_COIN_TYPE),
    };
  }

  treasuryAddress(network: PaymentNetwork): string {
    return aptosAddressOfSecret(this.treasurySecret(network));
  }

  received(deposit: PaymentDeposit): Promise<bigint> {
    return this.client.faBalance(
      deposit.originChain as PaymentNetwork,
      aptosLongAddress(deposit.depositAddress),
      deposit.originContract ?? '',
    );
  }

  async blocker(transfer: SandboxTransfer): Promise<string | null> {
    const { network, token, amount } = transfer;
    const treasury = this.treasuryAddress(network);
    const [gasPrice, apt, held] = await Promise.all([
      this.client.gasUnitPrice(network),
      this.client.aptBalance(network, treasury),
      this.client.faBalance(network, treasury, token),
    ]);
    const gas = SANDBOX_APTOS_MAX_GAS_AMOUNT * gasPrice;
    if (apt < gas) {
      return `the treasury ${treasury} holds ${apt} octas of APT, below the ${gas} a transfer may burn: fund it with test APT`;
    }
    if (held < amount) {
      return `the treasury ${treasury} holds ${held} of ${token}, below ${amount}: fund it`;
    }
    return null;
  }

  async sign(transfer: SandboxTransfer): Promise<SignedSandboxTransfer> {
    const { network, token, recipient, amount } = transfer;
    const secret = this.treasurySecret(network);
    const sender = aptosAddressOfSecret(secret);
    const [onChain, gasUnitPrice] = await Promise.all([
      this.client.sequenceNumber(network, sender),
      this.client.gasUnitPrice(network),
    ]);
    const tracked = this.nextSequence.get(sender) ?? 0n;
    const sequenceNumber =
      (onChain ?? 0n) > tracked ? (onChain ?? 0n) : tracked;
    const signed = signAptosTransaction(
      aptosFaTransferRaw({
        sender,
        sequenceNumber,
        metadata: token,
        recipient,
        amount,
        maxGasAmount: SANDBOX_APTOS_MAX_GAS_AMOUNT,
        gasUnitPrice,
        expirationSecs: BigInt(
          Math.floor(Date.now() / 1000) + SANDBOX_APTOS_EXPIRATION_SECONDS,
        ),
        chainId: this.client.network(network).chainId,
      }),
      secret,
    );
    this.nextSequence.set(sender, sequenceNumber + 1n);
    return {
      hash: signed.hash,
      raw: signed.raw,
      nonce: sequenceNumber.toString(),
    };
  }

  broadcast(network: PaymentNetwork, raw: string): Promise<void> {
    return this.client.submit(network, raw);
  }

  async follow(row: SandboxPayout): Promise<SandboxTxOutcome> {
    const network = row.network as PaymentNetwork;
    const found = await this.client.transactionByHash(network, row.txHash);
    if (found?.state === 'pending') return 'pending';
    if (found?.state === 'committed') {
      if (!found.success) {
        this.logger.error(
          `Sandbox ${row.kind} ${row.txHash} aborted on ${network}: ${found.vmStatus}`,
        );
      }
      return found.success ? 'succeeded' : 'failed';
    }
    const tx = decodeAptosSignedTransaction(row.raw);
    if (BigInt(Math.floor(Date.now() / 1000)) <= tx.expirationSecs) {
      await this.client.submit(network, row.raw);
      return 'pending';
    }
    // Expired and unknown by hash: final only when it provably never ran.
    const onChain = await this.client.sequenceNumber(network, tx.sender);
    if (onChain === null || onChain <= tx.sequenceNumber) {
      return 'failed';
    }
    const taken = await this.client.accountTransactionAt(
      network,
      tx.sender,
      tx.sequenceNumber,
    );
    if (taken?.state === 'committed' && taken.hash !== tx.hash) {
      return 'failed';
    }
    this.logger.warn(
      `Sandbox ${row.kind} ${row.txHash} on ${network}: expired and not found, ` +
        `but sequence ${tx.sequenceNumber} was consumed by a transaction this node no longer lists`,
    );
    return 'pending';
  }

  explorerTx(network: PaymentNetwork, hash: string): string {
    return `${this.client.network(network).explorerTx}${hash}${SANDBOX_APTOS_EXPLORER_QUERY}`;
  }

  async treasuryReport(network: PaymentNetwork): Promise<string> {
    const entry = this.client.network(network);
    const treasury = this.treasuryAddress(network);
    const [apt, usdc] = await Promise.all([
      this.client.aptBalance(network, treasury),
      this.client.faBalance(network, treasury, entry.stablecoin.contract ?? ''),
    ]);
    const gas =
      apt === 0n
        ? 'no APT (account not funded yet)'
        : `${apt} octas of APT (${Number(apt) / Number(APTOS_OCTAS_PER_APT)} APT)`;
    return `treasury ${treasury} gas ${gas}, ${entry.stablecoin.symbol} ${usdc} base units`;
  }

  private treasurySecret(network: PaymentNetwork): Uint8Array {
    const hex = this.config.get('sandbox', { infer: true }).treasuryPrivateKey;
    if (!hex) throw new Error('SANDBOX_TREASURY_PRIVATE_KEY is not set');
    return treasurySubkey(hex, network);
  }
}
