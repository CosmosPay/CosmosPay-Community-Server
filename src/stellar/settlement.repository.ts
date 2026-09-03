import type { SwapStatus, WebhookEventType } from '@generated/prisma/client';

/** The columns the settlement machine needs, whatever the row otherwise holds. */
export interface SettlementRow {
  id: string;
  status: SwapStatus;
  settlementEpoch: number;
}

/**
 * The slice of a Prisma model delegate this needs. Structural, so `swap` and
 * `liquidityPoolOperation` both satisfy it without a shared base model.
 */
export interface SettlementDelegate<TRow> {
  updateMany(args: {
    where: { id: string; status?: { in: SwapStatus[] } | SwapStatus };
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
  findUniqueOrThrow(args: { where: { id: string } }): Promise<TRow>;
}

/** The two terminal events this resource publishes. */
export interface SettlementEvents {
  succeeded: WebhookEventType;
  failed: WebhookEventType;
}

/**
 * Emits a terminal webhook. Supplied by the owning service.
 *
 * The return value is deliberately ignored — the emitter reports whether the
 * dedup claim was won, which is its own concern; this machine only cares that
 * the emission was attempted by the caller that won the status CAS.
 */
export type SettlementEmitter<TRow> = (
  username: string,
  type: WebhookEventType,
  row: TRow,
) => Promise<unknown>;

/** What every transition returns: whether *this* caller won, and the row after. */
export interface SettlementOutcome<TRow> {
  applied: boolean;
  row: TRow;
}

/**
 * The compare-and-swap settlement machine shared by swaps and liquidity pools.
 *
 * These two modules carried a byte-identical copy of `guardedUpdate`,
 * `markSubmitted` and five `finalize*` methods — the same ~90 lines twice, with
 * only the Prisma delegate, the status sets and two event names differing. That
 * is the part of the codebase where a divergence costs the most: it decides
 * whether a payment is recorded as settled, and whether the integrator is told
 * once, twice, or never.
 *
 * The compare-and-swap is the whole point. `updateMany` with a `status` filter
 * either matches (this caller won the race and owns the side effects) or matches
 * nothing (someone else already moved the row). `applied` is that verdict, and
 * only the winner emits — which is what stops the observer and a concurrent
 * `submit` from both announcing the same settlement.
 */
export class SettlementRepository<TRow extends SettlementRow> {
  constructor(
    private readonly delegate: SettlementDelegate<TRow>,
    private readonly canSucceed: readonly SwapStatus[],
    private readonly inFlight: readonly SwapStatus[],
    private readonly events: SettlementEvents,
    private readonly emit: SettlementEmitter<TRow>,
  ) {}

  /**
   * Moves the row to `data.status` only if it is still in one of `from`.
   *
   * The read is a second statement rather than a `RETURNING`, so it reflects the
   * row a moment after the write — see the note on `applied` above: the verdict
   * comes from the update, never from comparing the read.
   */
  async guardedUpdate(
    id: string,
    from: readonly SwapStatus[],
    data: Record<string, unknown>,
  ): Promise<SettlementOutcome<TRow>> {
    const result = await this.delegate.updateMany({
      where: { id, status: { in: [...from] } },
      data,
    });
    const row = await this.delegate.findUniqueOrThrow({ where: { id } });
    return { applied: result.count > 0, row };
  }

  /**
   * PENDING → SUBMITTED, or FAILED → SUBMITTED for a genuine resubmission.
   *
   * The resubmission path bumps `settlementEpoch`, which is what lets the
   * terminal-event dedup key tell a second attempt apart from the first. Without
   * it a retry after a failure could never announce its own outcome.
   */
  async markSubmitted(id: string): Promise<SettlementOutcome<TRow>> {
    const resent = await this.delegate.updateMany({
      where: { id, status: 'FAILED' },
      data: { status: 'SUBMITTED', settlementEpoch: { increment: 1 } },
    });
    if (resent.count > 0) {
      const row = await this.delegate.findUniqueOrThrow({ where: { id } });
      return { applied: true, row };
    }
    return this.guardedUpdate(id, ['PENDING'], {
      status: 'SUBMITTED',
    });
  }

  /** Settles and announces it. Only the caller that won the CAS emits. */
  async finalizeSucceeded(
    id: string,
    username: string,
    txHash?: string,
  ): Promise<SettlementOutcome<TRow>> {
    const outcome = await this.guardedUpdate(id, this.canSucceed, {
      status: 'SUCCEEDED',
      ...(txHash ? { txHash } : {}),
    });
    if (outcome.applied) {
      await this.emit(username, this.events.succeeded, outcome.row);
    }
    return outcome;
  }

  /**
   * Settles without announcing.
   *
   * For the phantom rows of a historical duplicate `txHash`: one on-chain
   * transaction must produce one webhook, so the extra rows are settled quietly.
   */
  finalizeSucceededQuiet(
    id: string,
    txHash?: string,
  ): Promise<SettlementOutcome<TRow>> {
    return this.guardedUpdate(id, this.canSucceed, {
      status: 'SUCCEEDED',
      ...(txHash ? { txHash } : {}),
    });
  }

  async finalizeFailed(
    id: string,
    username: string,
  ): Promise<SettlementOutcome<TRow>> {
    const outcome = await this.guardedUpdate(id, this.inFlight, {
      status: 'FAILED',
    });
    if (outcome.applied) {
      await this.emit(username, this.events.failed, outcome.row);
    }
    return outcome;
  }

  finalizeFailedQuiet(id: string): Promise<SettlementOutcome<TRow>> {
    return this.guardedUpdate(id, this.inFlight, { status: 'FAILED' });
  }

  /**
   * Expiry is never announced: nothing happened on-chain, so there is nothing
   * to tell the integrator that they did not already know from the TTL.
   */
  finalizeExpired(id: string): Promise<SettlementOutcome<TRow>> {
    return this.guardedUpdate(id, this.inFlight, { status: 'EXPIRED' });
  }
}
