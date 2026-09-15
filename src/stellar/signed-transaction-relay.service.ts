import { Injectable, Logger } from '@nestjs/common';
import { FeeBumpTransaction, TransactionBuilder } from '@stellar/stellar-sdk';
import type { SwapStatus, WebhookEventType } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { StellarNetwork } from '@/config/configuration';
import { extractResultCodes } from '@/stellar/horizon-errors';
import type {
  SettlementEmitter,
  SettlementRepository,
  SettlementRow,
} from '@/stellar/settlement.repository';
import { SETTLEMENT_MAX_RESUBMITS } from '@/stellar/stellar.constants';
import { StellarService } from '@/stellar/stellar.service';

/**
 * Statuses a signed envelope may be relayed from. SUBMITTED is included so a
 * caller whose first attempt hit an unreachable Horizon can retry, and FAILED so
 * a rejected envelope can be re-sent (the settlement epoch is bumped for it, up
 * to {@link SETTLEMENT_MAX_RESUBMITS} times). SUCCEEDED is answered without
 * touching the network; EXPIRED can never settle.
 */
const RELAYABLE_STATUSES: readonly SwapStatus[] = [
  'PENDING',
  'SUBMITTED',
  'FAILED',
];

/** The columns relaying reads on top of the settlement machine's. */
export interface RelayRow extends SettlementRow {
  network: string;
  txHash: string;
  /** When the stored envelope stops being valid; null on rows without one. */
  expiresAt: Date | null;
}

/** The words that differ per resource in the relay's errors and logs. */
export interface RelayLabels {
  /** Completes "Cannot submit a PENDING …", e.g. `swap`. */
  resource: string;
  /** Completes "The signed transaction does not match this …". */
  match: string;
  /** Starts each log line, e.g. `Swap` in "Swap <id> rejected on submit". */
  log: string;
}

/**
 * Everything that genuinely differs between the resources that relay a signed
 * envelope: their table (through the settlement machine), their events, what a
 * response looks like, and — for liquidity pools — what settling one implies.
 */
export interface RelayProfile<TRow extends RelayRow, TView> {
  settlement: Pick<
    SettlementRepository<TRow>,
    'markSubmitted' | 'finalizeSucceeded' | 'finalizeFailed'
  >;
  /** Announced when this call wins PENDING/FAILED → SUBMITTED. */
  submittedEvent: WebhookEventType;
  emit: SettlementEmitter<TRow>;
  /**
   * Runs after this relay settles the row, and returns the row to present. Not
   * run when the row was already settled by someone else — that writer ran it.
   */
  afterSucceeded?: (row: TRow) => Promise<TRow>;
  /** The response shape of one row. */
  present: (row: TRow) => Promise<TView>;
  labels: RelayLabels;
  /** The owning service's logger, so the log lines keep their context. */
  logger: Logger;
}

/**
 * What a relay attempt came to. The owning service renames `view` to its own
 * response key; the other keys are the response, in the order it has always
 * been serialized.
 */
export type RelayOutcome<TView> =
  | { submitted: true; status: 'SUCCEEDED'; txHash: string; view: TView }
  | {
      submitted: false;
      status: 'FAILED';
      reason: string;
      resultCodes: string[];
      view: TView;
    };

type Envelope = ReturnType<typeof TransactionBuilder.fromXDR>;

/**
 * Relays a customer-signed envelope for a row this service built.
 *
 * Swaps and liquidity pools each carried this flow line for line, and it is the
 * part where a divergence is paid for in money: whether a caller can make us
 * broadcast a transaction we did not build, whether a network rejection can
 * overwrite a settlement the observer already recorded, and whether an outage
 * strands the row. The steps, and why each one is where it is:
 *
 *   1. **The envelope is checked before anything about the row is answered** —
 *      not the SUCCEEDED short-circuit, not even the status in an error. Until
 *      then the caller has shown nothing but a row id, and under the shared
 *      public key every anonymous wallet is the same consumer, so ownership
 *      filtering does not keep one out of another's rows. The envelope must
 *      parse, must hash to the `txHash` we stored under the passphrase of the
 *      row's *stored* network (never the caller's key: signing does not change a
 *      transaction's hash, so anything else is an arbitrary transaction), and
 *      must carry a signature — the unsigned envelope the create response hands
 *      out hashes the same, and relaying it can only be rejected.
 *   2. **A row that can no longer succeed is not broadcast.** A FAILED row that
 *      has spent its {@link SETTLEMENT_MAX_RESUBMITS} resubmits, and any row
 *      whose envelope has lapsed, is refused without touching the network or
 *      the epoch: each rejected resubmit is a Horizon submission and a new
 *      terminal webhook. A lapsed in-flight row is left as it is for the
 *      observer, which settles it from the ledger — SUCCEEDED if it landed in
 *      time, EXPIRED on a 404.
 *   3. **SUBMITTED is written before broadcasting**, through the settlement
 *      compare-and-swap, so an unreachable network leaves the row re-submittable
 *      and only the winner of that write announces the submission. The same
 *      write carries the resubmit cap, so concurrent resubmits cannot all pass
 *      step 2 and bump past it.
 *   4. **A rejection finalizes FAILED only while the row is still in flight.**
 *      The observer may have settled the same hash during the round-trip (a
 *      `tx_already_included` rejection is exactly that), and on-chain success
 *      wins.
 *   5. **An unreachable Horizon is a 503** and changes nothing further.
 */
@Injectable()
export class SignedTransactionRelay {
  constructor(private readonly stellar: StellarService) {}

  async submit<TRow extends RelayRow, TView>(
    row: TRow,
    username: string,
    signedXdr: string,
    profile: RelayProfile<TRow, TView>,
  ): Promise<RelayOutcome<TView>> {
    const { settlement, labels, logger } = profile;

    const tx = this.verifiedEnvelope(row, signedXdr, labels);

    // Already settled — a retry of the same envelope; answer without the network.
    if (row.status === 'SUCCEEDED') {
      return {
        submitted: true,
        status: 'SUCCEEDED',
        txHash: row.txHash,
        view: await profile.present(row),
      };
    }
    if (!RELAYABLE_STATUSES.includes(row.status)) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Cannot submit a ${row.status} ${labels.resource}`,
      );
    }
    if (resubmitsExhausted(row)) {
      logger.warn(
        `${labels.log} ${row.id} resubmit refused: all ${SETTLEMENT_MAX_RESUBMITS} spent`,
      );
      throw resubmitsExhaustedError(labels);
    }
    if (hasLapsed(tx, row)) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `This ${labels.match}'s transaction expired and can no longer be ` +
          'submitted. If it reached the network before then, it will still settle.',
      );
    }

    // Mark in-flight before broadcasting; on an unreachable network we leave it
    // here (re-submittable), only advancing to a terminal state on a real result.
    // Observer may have liquidated the row between our read and this write.
    const submitted = await settlement.markSubmitted(row.id);
    if (submitted.row.status === 'SUCCEEDED') {
      return {
        submitted: true,
        status: 'SUCCEEDED',
        txHash: submitted.row.txHash,
        view: await profile.present(submitted.row),
      };
    }
    // A concurrent resubmit spent the last one between our read and this write.
    if (resubmitsExhausted(submitted.row)) {
      logger.warn(
        `${labels.log} ${row.id} resubmit refused: all ${SETTLEMENT_MAX_RESUBMITS} spent`,
      );
      throw resubmitsExhaustedError(labels);
    }
    if (submitted.row.status !== 'SUBMITTED') {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Cannot submit a ${submitted.row.status} ${labels.resource}`,
      );
    }
    if (submitted.applied) {
      await profile.emit(username, profile.submittedEvent, submitted.row);
    }

    try {
      const res = await this.stellar
        .server(row.network as StellarNetwork)
        .submitTransaction(tx);
      const succeeded = await settlement.finalizeSucceeded(
        row.id,
        username,
        res.hash,
      );
      const settled = profile.afterSucceeded
        ? await profile.afterSucceeded(succeeded.row)
        : succeeded.row;
      logger.log(
        `${labels.log} ${row.id} submitted and confirmed (tx=${res.hash})`,
      );
      return {
        submitted: true,
        status: 'SUCCEEDED',
        txHash: settled.txHash,
        view: await profile.present(settled),
      };
    } catch (err) {
      const resultCodes = extractResultCodes(err);
      if (resultCodes) {
        const failed = await settlement.finalizeFailed(row.id, username);
        if (failed.row.status === 'SUCCEEDED') {
          // Observer already settled this tx on-chain. Do not report failure,
          // and do not touch what its settlement recorded.
          logger.log(
            `${labels.log} ${row.id} Horizon rejection ignored; already SUCCEEDED`,
          );
          return {
            submitted: true,
            status: 'SUCCEEDED',
            txHash: failed.row.txHash,
            view: await profile.present(failed.row),
          };
        }
        logger.warn(
          `${labels.log} ${row.id} rejected on submit: ${resultCodes.join(', ')}`,
        );
        return {
          submitted: false,
          status: 'FAILED',
          reason: 'Transaction rejected by the network',
          resultCodes,
          view: await profile.present(failed.row),
        };
      }
      // Couldn't reach Horizon — leave it SUBMITTED so it can be retried.
      logger.error(`${labels.log} ${row.id} submission error`, err);
      throw ApiError.unavailable(
        ApiErrorCode.ProviderUnavailable,
        'Could not submit the transaction to the Stellar network',
      );
    }
  }

  /** Step 1: the caller's envelope, once it is shown to be this row's, signed. */
  private verifiedEnvelope(
    row: RelayRow,
    signedXdr: string,
    labels: RelayLabels,
  ): Envelope {
    let tx: Envelope;
    try {
      tx = TransactionBuilder.fromXDR(
        signedXdr,
        this.stellar.passphrase(row.network as StellarNetwork),
      );
    } catch {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'signedXdr is not a valid transaction envelope',
      );
    }

    // Integrity: signing does not change the hash, so the signed tx must hash to
    // the same value as the one we built and stored.
    if (Buffer.from(tx.hash()).toString('hex') !== row.txHash) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `The signed transaction does not match this ${labels.match}`,
      );
    }

    // Whether a signature is *valid* is the network's call — it knows the
    // account's signers and thresholds, and a bad one comes back `tx_bad_auth` —
    // but an envelope with none is the unsigned one we handed out.
    if (tx.signatures.length === 0) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'signedXdr carries no signatures; sign the transaction before submitting it',
      );
    }
    return tx;
  }
}

/** A FAILED row that has spent every resubmit it is allowed. */
function resubmitsExhausted(row: SettlementRow): boolean {
  return (
    row.status === 'FAILED' && row.settlementEpoch >= SETTLEMENT_MAX_RESUBMITS
  );
}

function resubmitsExhaustedError(labels: RelayLabels): ApiError {
  return ApiError.badRequest(
    ApiErrorCode.InvalidStateTransition,
    `Cannot submit a FAILED ${labels.resource} again: it was already ` +
      `resubmitted ${SETTLEMENT_MAX_RESUBMITS} times after a rejection. ` +
      `Build a new ${labels.resource}.`,
  );
}

/**
 * Whether the network can no longer accept the envelope.
 *
 * The envelope's `maxTime` is the bound the network enforces, and it is the one
 * we built — the hash check saw to that. `expiresAt` is the row's record of the
 * same deadline, written a moment after the build, and still decides for an
 * envelope with no upper bound (`maxTime` 0). Strictly past either, as the
 * observer's expiry reads it.
 */
function hasLapsed(tx: Envelope, row: RelayRow, now = Date.now()): boolean {
  const maxTime =
    tx instanceof FeeBumpTransaction ? 0 : Number(tx.timeBounds?.maxTime ?? 0);
  if (maxTime > 0 && now > maxTime * 1000) return true;
  return row.expiresAt != null && now > row.expiresAt.getTime();
}
