import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  EvmDepositAddress,
  PaymentIntent,
} from '@generated/prisma/client';
import { NATIVE_DECIMALS } from '@/chains/chains.constants';
import { parseUnits } from '@/chains/units';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { EvmRelayer } from '@/evm/evm-relayer.service';
import { EvmRpcClient } from '@/evm/evm-rpc.client';
import {
  DEPOSIT_FORWARD_BATCH,
  DEPOSIT_FORWARD_RESEND_MS,
  DEPOSIT_WATCH_WINDOW_MS,
  DETERMINISTIC_DEPLOYER,
  EVM_CHAINS,
  EVM_PROVIDER_NAMES,
  type EvmChain,
  isEvmChain,
} from '@/evm/evm.constants';
import {
  deployCalldata,
  depositAddress,
  FLUSH_CALLDATA,
  flushTokenCalldata,
  forwarderInitCode,
} from '@/evm/payment-forwarder';
import { readMerchantFeeRecord } from '@/common/merchant-fee/merchant-fee';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { PrismaService } from '@/prisma/prisma.service';

type WatchedDeposit = EvmDepositAddress & {
  intent: (PaymentIntent & { consumer: { apisixUsername: string } }) | null;
};

/** Statuses after which an intent will not settle by waiting any longer. */
const CLOSED = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']);

/**
 * Moves money from EVM deposit addresses (Monad, Arc) to merchants, and
 * settles the intents it paid. One job for every EVM chain with a relayer key:
 * each row names its chain, and the chain's relayer sends its forward.
 *
 * Each tick, for every deposit address still being watched:
 *
 *   - **AWAITING**: read the balance (the native coin, or the intent's token:
 *     on Arc, USDC through its ERC-20 interface, which also counts what a
 *     payer sent as a native transfer). Once
 *     it covers the intent's amount (any amount above the fee, for an open
 *     one), send the forward: the forwarder's deployment through the
 *     deterministic proxy, or `flush` / `flushToken` when it is already
 *     deployed. An intent that has closed without being paid in full — expired,
 *     cancelled — still has whatever arrived forwarded: it is the merchant's
 *     money either way, and it is not this service's to hold.
 *   - **FORWARDING**: look for the receipt. Success: FORWARDED, and the intent
 *     settles on that transaction if what was forwarded covered it. Reverted,
 *     or no receipt after {@link DEPOSIT_FORWARD_RESEND_MS}: back to AWAITING,
 *     and the next tick tries again — re-sending is safe, since the address can
 *     only be deployed once and the retry checks for code first.
 *   - **FORWARDED** with a token: a late token payment would otherwise sit at
 *     a deployed forwarder, which only forwards native coin by itself; it is
 *     flushed the same way. A deployed forwarder is flushed only for a balance
 *     worth the relayer's gas (`flushJustified`), never for dust.
 *
 * Settling on the FORWARD rather than on the payer's transaction is
 * deliberate: a balance has no transaction hash to prove it, and the forward is
 * the stronger fact — the money is on its way to the merchant, not just
 * parked. The payer can still settle sooner through
 * `POST /v1/payment-intents/{id}/validate` with their own hash.
 *
 * The whole cycle runs under the advisory lock, sends included: two replicas
 * forwarding at once would race the relayer's nonce and pay gas twice.
 */
@Injectable()
export class EvmDepositForwarderService extends ScheduledJob {
  protected readonly logger = new Logger(EvmDepositForwarderService.name);
  protected readonly lockKey = AdvisoryLockKey.EvmDepositForwarder;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly rpc: EvmRpcClient,
    private readonly relayer: EvmRelayer,
    private readonly paymentIntents: PaymentIntentsService,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  /** The EVM chains whose relayer key is configured. */
  private relayedChains(): EvmChain[] {
    return EVM_CHAINS.filter((chain) => this.relayer.isEnabled(chain));
  }

  /** On with the observer, and only where a relayer key is configured. */
  protected schedule(): JobSchedule {
    const { enabled, intervalMs } = this.config.get('observer', {
      infer: true,
    });
    const chains = this.relayedChains();
    return {
      enabled: enabled && chains.length > 0,
      intervalMs,
      description:
        chains.length > 0
          ? `EVM deposit forwarder (${chains
              .map((chain) => EVM_PROVIDER_NAMES[chain])
              .join(', ')})`
          : 'EVM deposit forwarder (no MONAD_RELAYER_PRIVATE_KEY or ARC_RELAYER_PRIVATE_KEY)',
    };
  }

  protected async run(): Promise<void> {
    const since = new Date(Date.now() - DEPOSIT_WATCH_WINDOW_MS);
    const rows = await this.prisma.evmDepositAddress.findMany({
      where: {
        // A chain whose relayer key was removed keeps its rows: they wait, and
        // move again once the key is back.
        chain: { in: this.relayedChains() },
        createdAt: { gte: since },
        OR: [
          { status: { in: ['AWAITING', 'FORWARDING'] } },
          { status: 'FORWARDED', token: { not: null } },
        ],
      },
      include: { intent: { include: { consumer: true } } },
      orderBy: { createdAt: 'asc' },
      take: DEPOSIT_FORWARD_BATCH,
    });

    // One at a time: every send goes through the relayer's one nonce.
    for (const row of rows) {
      try {
        if (row.status === 'FORWARDING') {
          await this.confirm(row);
        } else {
          await this.forwardIfFunded(row);
        }
      } catch (err) {
        this.logger.error(
          `Deposit ${row.address} (intent ${row.intentId ?? 'none'}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** Sends the forward once the balance covers the intent (or it has closed). */
  async forwardIfFunded(row: WatchedDeposit): Promise<void> {
    const chain = chainOf(row);
    const network = row.network as StellarNetwork;
    const balance = row.token
      ? await this.rpc.erc20BalanceOf(chain, network, row.token, row.address)
      : await this.rpc.getBalance(chain, network, row.address);
    if (balance === 0n) return;

    const fee = BigInt(row.fee);
    const merchantFee = row.merchantFee ? BigInt(row.merchantFee) : 0n;
    const deployed = await this.rpc.hasCode(chain, network, row.address);
    // Before deployment the fees come out of the balance (the relayer's, and a
    // merchant fee), so a balance that does not exceed them would forward
    // nothing to the merchant. Wait for more.
    if (!deployed && balance <= fee + merchantFee) return;
    // After it, a flush pays the relayer nothing: only a balance worth its gas
    // is flushed, so dust sent to a forwarder cannot make the relayer burn gas.
    if (deployed && !flushJustified(row, balance)) return;

    if (row.status === 'AWAITING' && !this.shouldForward(row, balance)) return;

    let call: { to: string; data: string };
    if (deployed) {
      call = {
        to: row.address,
        data: row.token ? flushTokenCalldata(row.token) : FLUSH_CALLDATA,
      };
    } else {
      // The contract the address was minted from: a PaymentSplitForwarder when
      // the row carries a merchant fee, else a PaymentForwarder.
      const initCode = forwarderInitCode({
        destination: row.destination,
        token: row.token,
        relayer: row.relayer,
        fee,
        merchantFee:
          row.feeWallet && row.merchantFee
            ? { wallet: row.feeWallet, amount: merchantFee }
            : null,
      });
      // Deploying anything else would create a contract at SOME address and
      // leave the money where it is. The only way the two disagree is a
      // changed forwarder artifact; refuse loudly rather than spend gas on it.
      if (depositAddress(row.salt, initCode) !== row.address) {
        this.logger.error(
          `Deposit ${row.address} does not match the current forwarder ` +
            'bytecode: it was minted from another artifact. Not deploying; ' +
            'restore the artifact it was built from to move its funds.',
        );
        return;
      }
      call = {
        to: DETERMINISTIC_DEPLOYER,
        data: deployCalldata(row.salt, initCode),
      };
    }
    const hash = await this.relayer.send(chain, network, call);
    await this.prisma.evmDepositAddress.update({
      where: { id: row.id },
      data: {
        status: 'FORWARDING',
        forwardTxHash: hash,
        forwardedAmount: balance.toString(),
        forwardSentAt: new Date(),
        forwardAttempts: { increment: 1 },
      },
    });
    this.logger.log(
      `Forwarding ${balance} from ${row.address} to ${row.destination} in ${hash}` +
        (deployed ? ' (flush)' : ' (deploy)'),
    );
  }

  /**
   * Whether an AWAITING deposit should be forwarded now: when it covers the
   * intent, or when the intent will not be paid by waiting any longer (closed,
   * past its lifetime, or deleted) — what arrived is the merchant's.
   */
  private shouldForward(row: WatchedDeposit, balance: bigint): boolean {
    const intent = row.intent;
    if (!intent) return true;
    const expected = expectedAmount(intent);
    if (expected === null ? balance > 0n : balance >= expected) return true;
    const lapsed =
      intent.expiresAt !== null && intent.expiresAt.getTime() <= Date.now();
    return CLOSED.has(intent.status) || lapsed;
  }

  /** Follows a forward in flight to its receipt. */
  async confirm(row: WatchedDeposit): Promise<void> {
    const network = row.network as StellarNetwork;
    const receipt = row.forwardTxHash
      ? await this.rpc.getReceipt(chainOf(row), network, row.forwardTxHash)
      : null;

    if (!receipt) {
      const sent = row.forwardSentAt?.getTime() ?? 0;
      if (Date.now() - sent > DEPOSIT_FORWARD_RESEND_MS) {
        this.logger.warn(
          `Forward ${row.forwardTxHash} for ${row.address} has no receipt ` +
            'yet; sending it again',
        );
        await this.backToAwaiting(row);
      }
      return;
    }

    if (receipt.status !== '0x1') {
      this.logger.warn(
        `Forward ${row.forwardTxHash} for ${row.address} reverted; retrying`,
      );
      await this.backToAwaiting(row);
      return;
    }

    await this.prisma.evmDepositAddress.update({
      where: { id: row.id },
      data: { status: 'FORWARDED', forwardedAt: new Date() },
    });
    await this.settle(row);
  }

  private backToAwaiting(row: WatchedDeposit) {
    return this.prisma.evmDepositAddress.update({
      where: { id: row.id },
      data: { status: 'AWAITING' },
    });
  }

  /**
   * Settles the intent on the confirmed forward, when what was forwarded
   * covers it. An intent that is already settled — the payer's own hash went
   * through `validate` — or cancelled or failed is left as it is; an EXPIRED
   * one settles, as a payment verified after expiry always may.
   */
  private async settle(row: WatchedDeposit): Promise<void> {
    const intent = row.intent;
    if (!intent || !row.forwardTxHash || !row.forwardedAmount) return;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(intent.status)) return;
    const expected = expectedAmount(intent);
    const forwarded = BigInt(row.forwardedAmount);
    const covers = expected === null ? forwarded > 0n : forwarded >= expected;
    if (!covers) {
      this.logger.warn(
        `Deposit ${row.address} forwarded ${forwarded}, short of intent ` +
          `${intent.id}'s ${expected}; the intent is not settled`,
      );
      return;
    }
    await this.paymentIntents.markSucceeded(
      intent.id,
      intent.consumer.apisixUsername,
      row.forwardTxHash,
      undefined,
      'observer',
      // No chain time: the payer's deposit into the address was public before
      // the sweep, and its own time is not read here, so `paidOnChainAt` stays
      // null and no checkout proof counts for the receipt (fail closed).
      undefined,
    );
  }
}

/**
 * A deposit row's chain. Rows are written only for EVM chains; anything else
 * is a data error, and forwarding it through another chain's relayer would be
 * worse than stopping.
 */
function chainOf(row: Pick<EvmDepositAddress, 'chain' | 'address'>): EvmChain {
  if (!isEvmChain(row.chain)) {
    throw new Error(
      `Deposit ${row.address} is on unknown chain "${row.chain}"`,
    );
  }
  return row.chain;
}

/**
 * Whether a DEPLOYED forwarder's balance is worth a flush. A flush pays the
 * relayer nothing (its fee was the deployment's), so each one is gas the
 * relayer gives away, and anyone can send a forwarder dust for the price of a
 * transfer, on Monad and Arc alike. The floor is the row's own `fee`: the price
 * this service put on one forward in the deposit's asset when it minted the
 * address (from the gas price, or `<CHAIN>_DEPOSIT_TOKEN_FEES`), and a flush
 * costs less gas than that deployment. A deposit in an asset with no price (a
 * token with no configured fee: `fee` 0) is flushed only for a whole payment,
 * the intent's amount, and never for an open-amount intent. A balance under the
 * floor is not lost: `flush` / `flushToken` are open to anyone and can only pay
 * the merchant.
 */
function flushJustified(row: WatchedDeposit, balance: bigint): boolean {
  const fee = BigInt(row.fee);
  if (fee > 0n) return balance > fee;
  const expected = row.intent ? expectedAmount(row.intent) : null;
  return expected !== null && balance >= expected;
}

/**
 * What the intent's payer deposits, in base units, or null for an open amount:
 * the amount, plus a merchant fee the payer pays on top (the forwarder pays the
 * fee out of the deposit).
 */
function expectedAmount(intent: PaymentIntent): bigint | null {
  if (intent.amount === null) return null;
  const native = isEvmChain(intent.chain)
    ? NATIVE_DECIMALS[intent.chain]
    : NATIVE_DECIMALS.monad;
  const decimals = intent.assetIssuer
    ? (intent.assetDecimals ?? native)
    : native;
  const amount = parseUnits(intent.amount, decimals);
  const fee = readMerchantFeeRecord(intent.merchantFee);
  return fee?.paidBy === 'payer'
    ? amount + parseUnits(fee.amount, decimals)
    : amount;
}
