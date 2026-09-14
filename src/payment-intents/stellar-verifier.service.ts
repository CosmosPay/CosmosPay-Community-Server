import { Injectable, Logger } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';
import { StellarService } from '@/stellar/stellar.service';
import { toStroops } from '@/swaps/swap-math';
import type { PaymentIntent } from '@generated/prisma/client';
import type { StellarNetwork } from '@/config/configuration';
import { TX_CREATED_AT_SKEW_MS } from '@/payment-intents/payment-intents.constants';

export interface VerificationResult {
  valid: boolean;
  txHash?: string;
  reason?: string;
  /** The payer (source) account of the matched on-chain payment, when valid. */
  payer?: string;
  /**
   * The transaction is this intent's payment — memo, age and a payment
   * operation all match — but it failed on-chain. Only this may settle an
   * intent as FAILED; every other invalid result is a mismatch.
   */
  failedOnChain?: boolean;
}

/**
 * Confirms that an on-chain Stellar transaction actually fulfills a payment
 * intent: it must be successful, closed no earlier than the intent was created,
 * contain a payment to the intent's destination in the intent's asset for the
 * exact amount, and the transaction memo must match. Each intent carries its own
 * `network` (derived from the API key type), so all Horizon calls target that
 * network. Used both by the manual `validate` endpoint and the permanent
 * observer, so the rule lives in one place.
 */
@Injectable()
export class StellarVerifierService {
  private readonly logger = new Logger(StellarVerifierService.name);

  constructor(private readonly stellar: StellarService) {}

  private server(intent: PaymentIntent): Horizon.Server {
    return this.stellar.server(intent.network as StellarNetwork);
  }

  /**
   * Verifies a specific transaction hash against the intent.
   *
   * Success is checked last, once the transaction has been shown to be this
   * intent's payment. It used to be checked first, and FAILED is terminal: the
   * hash of any failed transaction on the network — nothing to do with this
   * intent — permanently failed it through `POST /:id/validate`. Now a failed
   * transaction reports `failedOnChain` only when its memo, its age and one of
   * its payment operations all match, which is the payer's own attempt bouncing
   * (underfunded, missing trustline). Anything else is a mismatch.
   *
   * Horizon returns a transaction's operations by hash whether or not it
   * succeeded; if it ever stopped doing so, a failed payment would read as a
   * mismatch and leave the intent PENDING, which is the safe direction.
   */
  async verifyByHash(
    intent: PaymentIntent,
    txHash: string,
  ): Promise<VerificationResult> {
    const server = this.server(intent);
    let tx: Horizon.ServerApi.TransactionRecord;
    try {
      tx = await server.transactions().transaction(txHash).call();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 404) {
        return { valid: false, reason: 'Transaction not found on-chain' };
      }
      throw err;
    }

    const memoCheck = this.memoMatches(intent, tx.memo_type, tx.memo);
    if (!memoCheck.ok) {
      return { valid: false, reason: memoCheck.reason };
    }

    if (this.predatesIntent(intent, tx.created_at)) {
      return {
        valid: false,
        reason: 'Transaction predates this payment intent',
      };
    }

    const payments = await server.payments().forTransaction(txHash).call();
    const match = payments.records.find((op) =>
      this.paymentMatches(intent, op),
    );
    if (!match) {
      return {
        valid: false,
        reason:
          'No native payment in this transaction matches the destination/amount',
      };
    }

    if (!tx.successful) {
      return {
        valid: false,
        failedOnChain: true,
        reason: 'Transaction failed on-chain',
      };
    }

    const payer = (match as Horizon.ServerApi.PaymentOperationRecord).from;
    return { valid: true, txHash, payer };
  }

  /**
   * Scans recent payments to the intent's destination and returns the hash of
   * the first transaction that fully matches (used by the observer when no hash
   * was reported by the integrator).
   */
  async findMatchingPayment(
    intent: PaymentIntent,
    limit = 50,
  ): Promise<VerificationResult> {
    const server = this.server(intent);
    let page: Horizon.ServerApi.CollectionPage<Horizon.ServerApi.OperationRecord>;
    try {
      page = await server
        .payments()
        .forAccount(intent.destination)
        .order('desc')
        .limit(limit)
        .call();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 404) {
        return { valid: false, reason: 'Destination account not found' };
      }
      throw err;
    }

    for (const op of page.records) {
      // The page is newest first, so everything past the first record older
      // than the intent is older still — and each candidate would cost a
      // transaction lookup to rule out.
      if (this.predatesIntent(intent, op.created_at)) {
        break;
      }
      if (!this.paymentMatches(intent, op)) {
        continue;
      }
      // Confirm success + memo on the owning transaction.
      const tx = await server
        .transactions()
        .transaction(op.transaction_hash)
        .call();
      if (!tx.successful) {
        continue;
      }
      if (!this.memoMatches(intent, tx.memo_type, tx.memo).ok) {
        continue;
      }
      const payer = (op as Horizon.ServerApi.PaymentOperationRecord).from;
      return { valid: true, txHash: op.transaction_hash, payer };
    }

    return { valid: false, reason: 'No matching payment found yet' };
  }

  /**
   * Whether a transaction closed too early to be this intent's payment.
   *
   * A payment is built after its intent exists, so a ledger that closed before
   * then is some older payment that happens to carry the same memo, destination
   * and amount. The allowance is clock skew only ({@link TX_CREATED_AT_SKEW_MS}).
   * A close time that does not parse fails closed: nothing shows it is recent.
   */
  private predatesIntent(intent: PaymentIntent, closedAt: string): boolean {
    const closed = Date.parse(closedAt);
    if (Number.isNaN(closed)) {
      return true;
    }
    return closed < intent.createdAt.getTime() - TX_CREATED_AT_SKEW_MS;
  }

  /**
   * A payment to the right destination, in the intent's asset, for the exact
   * amount. The amount check is skipped for open intents (no fixed amount).
   */
  private paymentMatches(
    intent: PaymentIntent,
    op: Horizon.ServerApi.OperationRecord,
  ): boolean {
    if (op.type !== Horizon.HorizonApi.OperationResponseType.payment) {
      return false;
    }
    const p = op;

    if (p.to !== intent.destination) {
      return false;
    }

    // Asset must match: native, or exact code + issuer.
    if (intent.asset === 'native') {
      if (p.asset_type !== 'native') return false;
    } else if (
      p.asset_code !== intent.asset ||
      p.asset_issuer !== intent.assetIssuer
    ) {
      return false;
    }

    // Exact amount only when the intent fixed one.
    if (intent.amount != null && !this.amountMatches(intent.amount, p.amount)) {
      return false;
    }

    return true;
  }

  /**
   * Exact amount equality, in integer stroops.
   *
   * The strings cannot be compared directly — Horizon reports "25.5000000"
   * where the intent stored "25.5" — but `Number()` is not the way around that:
   * a Stellar amount is an int64 count of stroops, and float64 carries only 53
   * mantissa bits, so above ~9·10^15 stroops (~9·10^8 units) two different
   * amounts round to the same double and an underpayment would satisfy the
   * intent. This is the check that decides whether an on-chain payment settles
   * a payment intent, so it uses the same exact bigint arithmetic (`toStroops`)
   * that the swap fee/slippage math runs on.
   *
   * An unparseable amount on either side is "not a match", not a throw: this
   * predicate runs inside the observer's reconcile loop, where one malformed
   * row must not abort the sweep.
   */
  private amountMatches(expected: string, actual: string): boolean {
    try {
      return toStroops(actual) === toStroops(expected);
    } catch (err) {
      this.logger.warn(
        `Amount comparison skipped ("${expected}" vs "${actual}"): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  /**
   * The transaction must carry the intent's MEMO_ID. The memo is mandatory and
   * is exactly how a payment is tied back to its intent on-chain.
   */
  private memoMatches(
    intent: PaymentIntent,
    memoType: string | undefined,
    memo: string | undefined,
  ): { ok: boolean; reason?: string } {
    if (memoType !== 'id' || String(memo ?? '') !== intent.memo) {
      return {
        ok: false,
        reason: `Memo mismatch (expected id memo "${intent.memo}")`,
      };
    }
    return { ok: true };
  }
}
