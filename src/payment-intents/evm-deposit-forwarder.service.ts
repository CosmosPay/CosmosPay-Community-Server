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
  type EvmChain,
} from '@/evm/evm.constants';
import {
  deployCalldata,
  depositAddress,
  FLUSH_CALLDATA,
  flushTokenCalldata,
  forwarderInitCode,
} from '@/evm/payment-forwarder';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { PrismaService } from '@/prisma/prisma.service';

type WatchedDeposit = EvmDepositAddress & {
  intent: (PaymentIntent & { consumer: { apisixUsername: string } }) | null;
};

/** Statuses after which an intent will not settle by waiting any longer. */
const CLOSED = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']);

/**
 * Moves money from Monad deposit addresses to merchants, and settles the
 * intents it paid.
 *
 * Each tick, for every deposit address still being watched:
 *
 *   - **AWAITING** — read the balance (native MON, or the intent's token). Once
 *     it covers the intent's amount (any amount above the fee, for an open
 *     one), send the forward: the forwarder's deployment through the
 *     deterministic proxy, or `flush` / `flushToken` when it is already
 *     deployed. An intent that has closed without being paid in full — expired,
 *     cancelled — still has whatever arrived forwarded: it is the merchant's
 *     money either way, and it is not this service's to hold.
 *   - **FORWARDING** — look for the receipt. Success: FORWARDED, and the intent
 *     settles on that transaction if what was forwarded covered it. Reverted,
 *     or no receipt after {@link DEPOSIT_FORWARD_RESEND_MS}: back to AWAITING,
 *     and the next tick tries again — re-sending is safe, since the address can
 *     only be deployed once and the retry checks for code first.
 *   - **FORWARDED** with a token — a late token payment would otherwise sit at
 *     a deployed forwarder, which only forwards native coin by itself; it is
 *     flushed the same way.
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
  private readonly chain: EvmChain = 'monad';

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

  /** On with the observer, and only where a relayer key is configured. */
  protected schedule(): JobSchedule {
    const { enabled, intervalMs } = this.config.get('observer', {
      infer: true,
    });
    const relayer = this.relayer.isEnabled(this.chain);
    return {
      enabled: enabled && relayer,
      intervalMs,
      description: relayer
        ? 'Monad deposit forwarder'
        : 'Monad deposit forwarder (no MONAD_RELAYER_PRIVATE_KEY)',
    };
  }

  protected async run(): Promise<void> {
    const since = new Date(Date.now() - DEPOSIT_WATCH_WINDOW_MS);
    const rows = await this.prisma.evmDepositAddress.findMany({
      where: {
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
          `Deposit ${row.address} (intent ${row.intentId ?? '—'}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** Sends the forward once the balance covers the intent (or it has closed). */
  async forwardIfFunded(row: WatchedDeposit): Promise<void> {
    const network = row.network as StellarNetwork;
    const balance = row.token
      ? await this.rpc.erc20BalanceOf(
          this.chain,
          network,
          row.token,
          row.address,
        )
      : await this.rpc.getBalance(this.chain, network, row.address);
    if (balance === 0n) return;

    const fee = BigInt(row.fee);
    const deployed = await this.rpc.hasCode(this.chain, network, row.address);
    // Before deployment the fee comes out of the balance, so a balance that
    // does not exceed it would forward nothing to the merchant. Wait for more.
    if (!deployed && balance <= fee) return;

    if (row.status === 'AWAITING' && !this.shouldForward(row, balance)) return;

    let call: { to: string; data: string };
    if (deployed) {
      call = {
        to: row.address,
        data: row.token ? flushTokenCalldata(row.token) : FLUSH_CALLDATA,
      };
    } else {
      const initCode = forwarderInitCode({
        destination: row.destination,
        token: row.token,
        relayer: row.relayer,
        fee,
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
    const hash = await this.relayer.send(this.chain, network, call);
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
      ? await this.rpc.getReceipt(this.chain, network, row.forwardTxHash)
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
    );
  }
}

/** The intent's amount in base units, or null for an open amount. */
function expectedAmount(intent: PaymentIntent): bigint | null {
  if (intent.amount === null) return null;
  const decimals = intent.assetIssuer
    ? (intent.assetDecimals ?? NATIVE_DECIMALS.monad)
    : NATIVE_DECIMALS.monad;
  return parseUnits(intent.amount, decimals);
}
