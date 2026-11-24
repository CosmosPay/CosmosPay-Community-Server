import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentDeposit, SandboxPayout } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig } from '@/config/configuration';
import type { PaymentNetwork } from '@/payment-intents/payment-networks';
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
import {
  type SuiCoin,
  SandboxSuiClient,
  SuiGraphqlError,
  type SuiExecutionStatus,
} from '@/sandbox-settlement/sandbox-sui.client';
import {
  normalizeSuiAddress,
  packSuiSigned,
  signSuiTransaction,
  suiAddressOfSecret,
  suiCoinTransferBcs,
  suiTransactionDigest,
  unpackSuiSigned,
} from '@/sandbox-settlement/sandbox-sui.codec';
import {
  SUI_COIN_TYPE,
  SUI_COIN_TYPE_INDEX,
  SUI_TESTNET,
  SUI_TRANSFER_GAS_BUDGET,
} from '@/sandbox-settlement/sandbox-sui.constants';

/**
 * What a node answers when a transaction's inputs are gone for good: an
 * object already spent at a later version ("Transaction needs to be rebuilt
 * because object ... is unavailable for consumption, current version: ...",
 * as Sui testnet answered on 2026-11-17), or deleted. Such a transaction can
 * never execute (object versions only move forward), so it is failed, never
 * signed again.
 */
const INPUTS_GONE_RE =
  /(?:un|not )available for consumption|could not find the referenced object/i;

/** The coins, largest first, that cover `amount`; null when they cannot. */
function cover(coins: SuiCoin[], amount: bigint): SuiCoin[] | null {
  const picked: SuiCoin[] = [];
  let sum = 0n;
  for (const coin of coins) {
    if (sum >= amount) break;
    picked.push(coin);
    sum += coin.balance;
  }
  return sum >= amount && picked.length > 0 ? picked : null;
}

/**
 * The sandbox on Sui testnet: a deposit address per payment (SLIP-0010 at
 * `m/44'/784'/7007'/a'/b'`), its total balance of the test USDC as what
 * arrived, and programmable transactions from the treasury (HKDF of the
 * treasury key for `sui`) that merge its USDC coins, split the amount off and
 * transfer it. The treasury spends coin OBJECTS only, for the USDC and the gas
 * alike; what an address holds in its address balance counts as arrived for a
 * deposit but is not spent by a payout.
 */
@Injectable()
export class SandboxSuiLedger implements SandboxLedger {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly client: SandboxSuiClient,
  ) {}

  newDeposit(): SandboxDepositTarget {
    const indexes = newDepositIndexes();
    const seed = this.config.get('sandbox', { infer: true }).depositSeed;
    return {
      address: suiAddressOfSecret(
        ed25519DepositSecret(seed, SUI_COIN_TYPE_INDEX, indexes),
      ),
      memo: null,
      locator: depositPath(indexes, SUI_COIN_TYPE_INDEX),
    };
  }

  treasuryAddress(): string {
    return suiAddressOfSecret(this.treasurySecret());
  }

  /** Coin objects and address balance alike: both are the payer's USDC arriving. */
  async received(deposit: PaymentDeposit): Promise<bigint> {
    const balance = await this.client.balance(
      deposit.depositAddress,
      deposit.originContract ?? this.usdc(),
    );
    return balance.total;
  }

  async blocker(transfer: SandboxTransfer): Promise<string | null> {
    const treasury = this.treasuryAddress();
    const [token, gas] = await Promise.all([
      this.client.balance(treasury, transfer.token),
      this.client.balance(treasury, SUI_COIN_TYPE),
    ]);
    if (token.coins < transfer.amount) {
      const parked =
        token.addressBalance > 0n
          ? ` (its ${token.addressBalance} in the address balance is not spent by the sandbox)`
          : '';
      return (
        `the treasury ${treasury} holds ${token.coins} of ${transfer.token} in coin objects${parked}, ` +
        `below ${transfer.amount}: fund it`
      );
    }
    if (gas.coins < SUI_TRANSFER_GAS_BUDGET) {
      return (
        `the treasury ${treasury} holds ${gas.coins} MIST of SUI in coin objects, ` +
        `below the ${SUI_TRANSFER_GAS_BUDGET} gas budget: fund it with test SUI`
      );
    }
    return null;
  }

  async sign(transfer: SandboxTransfer): Promise<SignedSandboxTransfer> {
    const secret = this.treasurySecret();
    const treasury = suiAddressOfSecret(secret);
    const [tokenCoins, gasCoins, gasPrice] = await Promise.all([
      this.client.coins(treasury, transfer.token),
      this.client.coins(treasury, SUI_COIN_TYPE),
      this.client.referenceGasPrice(),
    ]);
    const coins = cover(tokenCoins, transfer.amount);
    const gas = cover(gasCoins, SUI_TRANSFER_GAS_BUDGET);
    if (!coins || !gas) {
      throw new Error(
        `The Sui treasury ${treasury} cannot cover ${transfer.amount} of ` +
          `${transfer.token} and the gas budget with its first coin objects`,
      );
    }
    const txBytes = suiCoinTransferBcs({
      sender: treasury,
      coins: coins.map((c) => c.ref),
      recipient: normalizeSuiAddress(transfer.recipient),
      amount: transfer.amount,
      gasPayment: gas.map((c) => c.ref),
      gasPrice,
      gasBudget: SUI_TRANSFER_GAS_BUDGET,
    });
    return {
      hash: suiTransactionDigest(txBytes),
      raw: packSuiSigned(txBytes, signSuiTransaction(txBytes, secret)),
      // Sui has no account nonce: the gas coin's version plays its part (a
      // transaction is valid only while its inputs are at those versions).
      nonce: gas[0].ref.version.toString(),
    };
  }

  async broadcast(_network: PaymentNetwork, raw: string): Promise<void> {
    try {
      await this.execute(raw);
    } catch (err) {
      throw err instanceof SuiGraphqlError
        ? ApiError.badGateway(
            ApiErrorCode.ProviderError,
            `${SUI_TESTNET.testnetName} refused the transaction: ${err.message}`,
          )
        : err;
    }
  }

  /**
   * Known: its effects decide. Unknown: the same signed bytes are executed
   * again, and their effects decide; a node that answers the inputs are gone
   * (and still does not know the digest) means it can never run.
   */
  async follow(row: SandboxPayout): Promise<SandboxTxOutcome> {
    const known = await this.client.transactionStatus(row.txHash);
    if (known) return this.outcome(known);
    try {
      return this.outcome(await this.execute(row.raw));
    } catch (err) {
      if (!(err instanceof SuiGraphqlError)) throw err;
      if (!INPUTS_GONE_RE.test(err.message)) return 'pending';
      const again = await this.client.transactionStatus(row.txHash);
      return again ? this.outcome(again) : 'failed';
    }
  }

  explorerTx(_network: PaymentNetwork, hash: string): string {
    return `${SUI_TESTNET.explorerTx}${hash}`;
  }

  async treasuryReport(): Promise<string> {
    const treasury = this.treasuryAddress();
    const [gas, token] = await Promise.all([
      this.client.balance(treasury, SUI_COIN_TYPE),
      this.client.balance(treasury, this.usdc()),
    ]);
    return (
      `treasury ${treasury} SUI ${gas.coins} MIST in coins (${gas.addressBalance} in address balance), ` +
      `${SUI_TESTNET.stablecoin.symbol} ${token.coins} base units in coins ` +
      `(${token.addressBalance} in address balance)`
    );
  }

  private execute(raw: string): Promise<SuiExecutionStatus> {
    const { txBytes, signature } = unpackSuiSigned(raw);
    return this.client.execute(txBytes, signature);
  }

  private outcome(status: SuiExecutionStatus): SandboxTxOutcome {
    return status === 'SUCCESS' ? 'succeeded' : 'failed';
  }

  private usdc(): string {
    const coinType = SUI_TESTNET.stablecoin.contract;
    if (!coinType) throw new Error('Sui testnet has no test USDC configured');
    return coinType;
  }

  private treasurySecret(): Uint8Array {
    const hex = this.config.get('sandbox', { infer: true }).treasuryPrivateKey;
    if (!hex) throw new Error('SANDBOX_TREASURY_PRIVATE_KEY is not set');
    return treasurySubkey(hex, 'sui');
  }
}
