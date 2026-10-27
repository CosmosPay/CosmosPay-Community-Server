import { Injectable, Logger } from '@nestjs/common';
import type {
  Prisma,
  Usdt0Transfer,
  Usdt0TransferStatus,
} from '@generated/prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { SorobanRpcClient } from '@/stellar/soroban-rpc.client';
import { LayerZeroScanClient } from '@/usdt0/layerzero-scan.client';
import { ledgerOutcome, type LedgerOutcome } from '@/usdt0/usdt0-ledger';
import { pickMessage, scanOutcome } from '@/usdt0/usdt0-scan';
import {
  STELLAR_EID,
  USDT0_EXPIRY_GRACE_MS,
  USDT0_STATUS_REFRESH_MS,
  USDT0_SUBMIT_POLL_MS,
  USDT0_SUBMIT_WAIT_MS,
} from '@/usdt0/usdt0.constants';

/** Statuses nothing moves out of: a read answers them from the row. */
const FINAL_STATUSES: readonly Usdt0TransferStatus[] = [
  'DELIVERED',
  'FAILED',
  'EXPIRED',
];

/**
 * Follows a USDT0 transfer after it is built: what the Stellar ledger says
 * about its transaction, then what LayerZero Scan says about its message.
 *
 * There is no background observer: a transfer moves when it is read (or
 * submitted), throttled per row by `lastCheckedAt`, because the wallet that
 * sent it is the one polling. Every move is a compare-and-swap on the status
 * the row was read with, so a submit and a read racing on one transfer write
 * one transition.
 *
 * The ledger is asked first, and also while PENDING: a SEP-7 wallet (or
 * Freighter) may broadcast the transaction itself and never call submit, and a
 * submit that stopped waiting has no guid yet. Only then is Scan asked, by guid
 * when it is known (Scan indexes a Stellar message by guid before it fills in
 * the source hash), by hash otherwise.
 */
@Injectable()
export class Usdt0TransferTracker {
  private readonly logger = new Logger(Usdt0TransferTracker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rpc: SorobanRpcClient,
    private readonly scan: LayerZeroScanClient,
  ) {}

  /**
   * The transfer as it stands now, asking upstream at most once per
   * {@link USDT0_STATUS_REFRESH_MS} per transfer. Never throws for an upstream
   * failure: the read answers from the row and the next one asks again.
   */
  async refresh(row: Usdt0Transfer, now = new Date()): Promise<Usdt0Transfer> {
    if (FINAL_STATUSES.includes(row.status)) return row;
    if (
      row.lastCheckedAt &&
      now.getTime() - row.lastCheckedAt.getTime() < USDT0_STATUS_REFRESH_MS
    ) {
      return row;
    }
    // Claim this window: of the reads racing here, one asks upstream.
    const { count } = await this.prisma.usdt0Transfer.updateMany({
      where: {
        id: row.id,
        status: row.status,
        lastCheckedAt: row.lastCheckedAt,
      },
      data: { lastCheckedAt: now },
    });
    if (count === 0) return this.reread(row);

    let current: Usdt0Transfer = { ...row, lastCheckedAt: now };
    try {
      if (current.status === 'PENDING' || !current.guid) {
        const tx = await this.rpc.getTransaction(current.txHash);
        current = await this.applyLedger(current, ledgerOutcome(tx), {
          accepted: false,
          now,
        });
      }
      if (current.status === 'SUBMITTED') {
        current = await this.followMessage(current);
      }
    } catch (err) {
      this.logger.warn(
        `USDT0 transfer ${row.id}: refresh failed, answered from the row (${String(err)})`,
      );
    }
    return current;
  }

  /**
   * After the RPC accepted the transaction: asks the ledger every
   * {@link USDT0_SUBMIT_POLL_MS} until it answers, for about
   * {@link USDT0_SUBMIT_WAIT_MS}. A transaction not applied by then is
   * SUBMITTED without a guid, and the next read settles it.
   */
  async awaitLedger(row: Usdt0Transfer): Promise<Usdt0Transfer> {
    // Counted in pauses rather than read off the clock: every lookup is
    // followed by a full pause, so the wait is at least the budget.
    const lookups = Math.ceil(USDT0_SUBMIT_WAIT_MS / USDT0_SUBMIT_POLL_MS);
    for (let lookup = 1; ; lookup += 1) {
      let outcome: LedgerOutcome = { kind: 'absent' };
      try {
        outcome = ledgerOutcome(await this.rpc.getTransaction(row.txHash));
      } catch (err) {
        // The RPC accepted it; a failed lookup is no news about the ledger.
        this.logger.warn(
          `USDT0 transfer ${row.id}: ledger lookup failed while waiting (${String(err)})`,
        );
      }
      if (outcome.kind !== 'absent' || lookup >= lookups) {
        return this.applyLedger(row, outcome, { accepted: true });
      }
      await this.pause(USDT0_SUBMIT_POLL_MS);
    }
  }

  /**
   * Moves a PENDING transfer, or a SUBMITTED one with no guid yet, by what the
   * ledger says about its transaction:
   *
   * - applied and successful: SUBMITTED, with the guid `send` returned;
   * - applied and failed: FAILED, with the result codes (the fee was charged,
   *   no USDT0 moved);
   * - absent, right after the RPC accepted it (`accepted`): SUBMITTED, guid
   *   to follow;
   * - absent past `expiresAt` and a grace period: EXPIRED, since its time
   *   bounds closed before it reached a ledger;
   * - absent otherwise: unchanged.
   */
  async applyLedger(
    row: Usdt0Transfer,
    outcome: LedgerOutcome,
    opts: { accepted: boolean; now?: Date },
  ): Promise<Usdt0Transfer> {
    const now = opts.now ?? new Date();
    if (row.status !== 'PENDING' && row.status !== 'SUBMITTED') return row;
    switch (outcome.kind) {
      case 'succeeded':
        if (!outcome.receipt) {
          this.logger.warn(
            `USDT0 transfer ${row.id}: send landed but its return value could not be read`,
          );
        }
        return this.transition(row, {
          status: 'SUBMITTED',
          guid: outcome.receipt?.guid ?? row.guid,
          submittedAt: row.submittedAt ?? now,
        });
      case 'failed':
        return this.transition(row, {
          status: 'FAILED',
          failureReason:
            'The Stellar transaction failed' +
            (outcome.codes.length ? ` (${outcome.codes.join(', ')})` : '') +
            '. No USDT0 moved; the network fee was charged.',
          submittedAt: row.submittedAt ?? now,
        });
      case 'absent':
        if (opts.accepted && row.status === 'PENDING') {
          return this.transition(row, {
            status: 'SUBMITTED',
            submittedAt: now,
          });
        }
        if (now.getTime() > row.expiresAt.getTime() + USDT0_EXPIRY_GRACE_MS) {
          return this.transition(row, { status: 'EXPIRED' });
        }
        return row;
    }
  }

  /** Asks LayerZero Scan about a SUBMITTED transfer's message, and records it. */
  private async followMessage(row: Usdt0Transfer): Promise<Usdt0Transfer> {
    const response = row.guid
      ? await this.scan.byGuid(row.guid)
      : await this.scan.byTransaction(row.txHash);
    const message = pickMessage(response, row.guid, STELLAR_EID);
    if (!message) return row;
    const outcome = scanOutcome(message);
    const guid = row.guid ?? outcome.guid;
    switch (outcome.kind) {
      case 'delivered':
        return this.transition(row, {
          status: 'DELIVERED',
          guid,
          scanStatus: outcome.scanStatus,
          destinationTxHash: outcome.destinationTxHash,
        });
      case 'failed':
        return this.transition(row, {
          status: 'FAILED',
          guid,
          scanStatus: outcome.scanStatus,
          failureReason: outcome.reason,
        });
      case 'travelling':
        if (outcome.scanStatus === row.scanStatus && guid === row.guid) {
          return row;
        }
        return this.transition(row, { guid, scanStatus: outcome.scanStatus });
    }
  }

  /**
   * Writes `data` if the row still has the status it was read with, and
   * answers the row as it now stands.
   */
  private async transition(
    row: Usdt0Transfer,
    data: Prisma.Usdt0TransferUpdateManyMutationInput & {
      status?: Usdt0TransferStatus;
    },
  ): Promise<Usdt0Transfer> {
    const { count } = await this.prisma.usdt0Transfer.updateMany({
      where: { id: row.id, status: row.status },
      data,
    });
    if (count === 1 && data.status && data.status !== row.status) {
      this.logger.log(
        `USDT0 transfer ${row.id}: ${row.status} -> ${data.status}`,
      );
    }
    return this.reread(row);
  }

  private async reread(row: Usdt0Transfer): Promise<Usdt0Transfer> {
    return (
      (await this.prisma.usdt0Transfer.findUnique({ where: { id: row.id } })) ??
      row
    );
  }

  /** A pause between ledger lookups; a seam for the specs. */
  protected pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
