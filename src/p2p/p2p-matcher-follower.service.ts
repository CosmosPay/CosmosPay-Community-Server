import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdvisoryLockKey,
  AdvisoryLockService,
} from '@/common/services/advisory-lock.service';
import { JobSchedule, ScheduledJob } from '@/common/services/scheduled-job';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { P2pChainClient } from '@/p2p/p2p-chain.client';
import { P2pNetworksService } from '@/p2p/p2p-networks.service';
import { P2pOrderOpener } from '@/p2p/p2p-order-opener.service';
import {
  P2P_MATCHER_FOLLOW_BATCH,
  P2P_MATCHER_REBROADCAST_MS,
} from '@/p2p/p2p.constants';

/**
 * Follows the matcher's transactions until each is mined. A transaction with
 * no receipt is sent again with its STORED bytes (never re-signed); one whose
 * nonce the chain has passed without it was replaced or dropped and is
 * `dropped`. An `open` that reverted or was dropped fails its order, so the
 * merchant's slot is free again; the other kinds change nothing here (the
 * indexer moves orders on what was mined).
 */
@Injectable()
export class P2pMatcherFollowerService extends ScheduledJob {
  protected readonly logger = new Logger(P2pMatcherFollowerService.name);
  protected readonly lockKey = AdvisoryLockKey.P2pMatcherFollower;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly networks: P2pNetworksService,
    private readonly chain: P2pChainClient,
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
      description: 'P2P matcher follower',
    };
  }

  protected lockTimeoutMs(): number {
    return this.networks.timeoutMs() * (P2P_MATCHER_FOLLOW_BATCH * 3 + 10);
  }

  protected async run(): Promise<void> {
    const rows = await this.prisma.p2pMatcherTx.findMany({
      where: { status: { in: ['signed', 'sent'] } },
      orderBy: { updatedAt: 'asc' },
      take: P2P_MATCHER_FOLLOW_BATCH,
    });
    for (const row of rows) {
      const d = this.networks.find(row.tier as StellarNetwork, row.network);
      if (!d) continue;
      try {
        const receipt = await this.chain.receipt(d, row.hash);
        if (receipt) {
          await this.prisma.p2pMatcherTx.updateMany({
            where: { id: row.id, status: { in: ['signed', 'sent'] } },
            data: {
              status: receipt.succeeded ? 'mined' : 'reverted',
              minedBlock: receipt.blockNumber,
            },
          });
          if (!receipt.succeeded) {
            this.logger.warn(
              `P2P matcher ${row.kind} ${row.hash} reverted on ${row.network}/${row.tier}`,
            );
            if (row.kind === 'open' && row.orderId) {
              await this.opener.fail(
                row.orderId,
                'the opening transaction reverted',
              );
            }
          }
          continue;
        }
        const mined = await this.chain.minedNonce(d, row.fromAddress);
        if (mined > row.nonce) {
          // That nonce is spent by another transaction: this one never will be.
          await this.prisma.p2pMatcherTx.updateMany({
            where: { id: row.id, status: { in: ['signed', 'sent'] } },
            data: { status: 'dropped' },
          });
          this.logger.error(
            `P2P matcher ${row.kind} ${row.hash} dropped: nonce ${row.nonce} was used by another transaction`,
          );
          if (row.kind === 'open' && row.orderId) {
            await this.opener.fail(
              row.orderId,
              'the opening transaction was dropped',
            );
          }
          continue;
        }
        if (
          Date.now() - row.updatedAt.getTime() >=
          P2P_MATCHER_REBROADCAST_MS
        ) {
          await this.chain.sendRawTransaction(d, row.raw);
          await this.prisma.p2pMatcherTx.update({
            where: { id: row.id },
            data: {
              status: 'sent',
              sentAt: row.sentAt ?? new Date(),
              lastError: null,
            },
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`P2P matcher ${row.kind} ${row.hash}: ${message}`);
        await this.prisma.p2pMatcherTx.update({
          where: { id: row.id },
          data: { lastError: message.slice(0, 500) },
        });
      }
    }
  }
}
