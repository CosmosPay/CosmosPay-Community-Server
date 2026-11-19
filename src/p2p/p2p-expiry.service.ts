import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { P2pCallReverted } from '@/p2p/p2p-chain.client';
import { p2pCalldata } from '@/p2p/p2p-market-abi';
import { P2pMarketReader } from '@/p2p/p2p-market-reader.service';
import { P2pMatcherService } from '@/p2p/p2p-matcher.service';
import { P2pNetworksService } from '@/p2p/p2p-networks.service';
import { P2pOrderOpener } from '@/p2p/p2p-order-opener.service';
import {
  P2P_EXPIRY_BATCH,
  P2P_EXPIRY_GRACE_SECONDS,
  P2P_SELL_SIGNATURE_TTL_SECONDS,
} from '@/p2p/p2p.constants';

/** Quotes and challenges are kept a day past their expiry, for support, then deleted. */
const STALE_ROWS_MS = 24 * 60 * 60 * 1000;

/**
 * Housekeeping, not a security boundary: anyone may cancel an order past its
 * deadline, and this job does it with the matcher so a merchant's liquidity
 * (or a seller's tokens) is not locked by an order nobody finished. It waits
 * {@link P2P_EXPIRY_GRACE_SECONDS} past the deadline, reads the order on-chain
 * first (an order the chain already moved costs no gas), and never sends a
 * second cancel while one is in flight. The indexer turns the cancel into
 * `expired`.
 *
 * It also fails the sales nobody signed in time, and deletes quotes and
 * registration challenges a day after they expired.
 */
@Injectable()
export class P2pExpiryService extends ScheduledJob {
  protected readonly logger = new Logger(P2pExpiryService.name);
  protected readonly lockKey = AdvisoryLockKey.P2pExpiry;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly networks: P2pNetworksService,
    private readonly reader: P2pMarketReader,
    private readonly matcher: P2pMatcherService,
    private readonly opener: P2pOrderOpener,
    locks: AdvisoryLockService,
  ) {
    super(locks);
  }

  protected schedule(): JobSchedule {
    const configured = this.networks.anyConfigured();
    return {
      enabled:
        this.config.get('observer', { infer: true }).enabled && configured,
      intervalMs: this.config.get('p2p', { infer: true }).indexerIntervalMs,
      description: 'P2P market expiry',
    };
  }

  protected lockTimeoutMs(): number {
    return this.networks.timeoutMs() * (P2P_EXPIRY_BATCH * 4 + 10);
  }

  protected async run(): Promise<void> {
    await this.cancelOverdue();
    await this.failUnsignedSales();
    const stale = new Date(Date.now() - STALE_ROWS_MS);
    await this.prisma.p2pQuote.deleteMany({
      where: { expiresAt: { lt: stale } },
    });
    await this.prisma.p2pAccountChallenge.deleteMany({
      where: { expiresAt: { lt: stale } },
    });
  }

  /** Cancels orders the chain still shows waiting past their deadline. */
  async cancelOverdue(): Promise<void> {
    const cutoff = new Date(Date.now() - P2P_EXPIRY_GRACE_SECONDS * 1000);
    const overdue = await this.prisma.p2pOrder.findMany({
      where: {
        onchainId: { not: null },
        OR: [
          { status: 'awaiting_acceptance', acceptDeadline: { lt: cutoff } },
          { status: 'awaiting_payment', paymentDeadline: { lt: cutoff } },
          // A failed order that opened after all (the indexer recorded it).
          {
            status: 'failed',
            chainStatus: 'Offered',
            acceptDeadline: { lt: cutoff },
          },
          {
            status: 'failed',
            chainStatus: 'Active',
            paymentDeadline: { lt: cutoff },
          },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: P2P_EXPIRY_BATCH,
      select: { id: true, tier: true, network: true, onchainId: true },
    });
    for (const order of overdue) {
      const inFlight = await this.prisma.p2pMatcherTx.count({
        where: {
          orderId: order.id,
          kind: 'cancel',
          status: { in: ['signed', 'sent'] },
        },
      });
      if (inFlight > 0) continue;
      const d = this.networks.find(order.tier as StellarNetwork, order.network);
      if (!d || !order.onchainId) continue;
      try {
        const onchain = await this.reader.getOrder(d, BigInt(order.onchainId));
        if (onchain.status !== 'Offered' && onchain.status !== 'Active') {
          // Moved on-chain already; a failed order is not followed by the
          // indexer, so record where it went and stop looking at it.
          await this.prisma.p2pOrder.updateMany({
            where: { id: order.id, status: 'failed' },
            data: { chainStatus: onchain.status },
          });
          continue;
        }
        await this.matcher.send(d, {
          kind: 'cancel',
          orderId: order.id,
          data: p2pCalldata.orderAction('cancel', BigInt(order.onchainId)),
        });
        this.logger.log(`P2P order ${order.id} past its deadline: cancel sent`);
      } catch (err) {
        if (err instanceof P2pCallReverted) {
          // The chain moved it meanwhile (paid in the last second, or cancelled).
          continue;
        }
        this.logger.warn(
          `P2P order ${order.id}: expiry cancel not sent: ${String(err)}`,
        );
      }
    }
  }

  /** A sale whose seller never signed: `failed`. A late signature still opens it (the indexer follows). */
  async failUnsignedSales(): Promise<void> {
    const before = new Date(Date.now() - P2P_SELL_SIGNATURE_TTL_SECONDS * 1000);
    const unsigned = await this.prisma.p2pOrder.findMany({
      where: { kind: 'SELL', status: 'pending', createdAt: { lt: before } },
      take: P2P_EXPIRY_BATCH,
      select: { id: true },
    });
    for (const order of unsigned) {
      await this.opener.fail(order.id, 'the seller did not sign it in time');
    }
  }
}
