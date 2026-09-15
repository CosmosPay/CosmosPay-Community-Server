import { Injectable, Logger } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';
import { StellarService } from '@/stellar/stellar.service';
import { toStroops } from '@/swaps/swap-math';
import type { PaymentIntent } from '@generated/prisma/client';
import type { StellarNetwork } from '@/config/configuration';
import {
  PAYMENT_SCAN_MAX_PAGES,
  PAYMENT_SCAN_PAGE_SIZE,
  TX_CREATED_AT_SKEW_MS,
} from '@/payment-intents/payment-intents.constants';

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
   * Scans payments to the intent's destination, newest first, and returns the
   * hash of the first transaction that fully matches (used by the observer when
   * no hash was reported by the integrator).
   *
   * It read a single page of the 50 newest payments, so enough payments landing
   * after the real one — dust, which anyone can send — hid it, and the intent
   * expired although it was paid. It now pages back until the payments predate
   * the intent, at most {@link PAYMENT_SCAN_MAX_PAGES} pages; the constant says
   * why running out of pages is a miss rather than an error.
   *
   * The owning transactions are joined into each page (`join=transactions`), so
   * a page costs one Horizon call however many of its payments are candidates.
   * Confirming memo and success used to cost a lookup per candidate — for an
   * open-amount intent, one per payment to the destination — which paging would
   * otherwise have multiplied by the number of pages.
   */
  async findMatchingPayment(
    intent: PaymentIntent,
  ): Promise<VerificationResult> {
    const server = this.server(intent);
    let page: Horizon.ServerApi.CollectionPage<Horizon.ServerApi.OperationRecord>;
    try {
      page = await server
        .payments()
        .forAccount(intent.destination)
        .join('transactions')
        .order('desc')
        .limit(PAYMENT_SCAN_PAGE_SIZE)
        .call();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 404) {
        return { valid: false, reason: 'Destination account not found' };
      }
      throw err;
    }

    for (let pages = 1; ; pages += 1) {
      for (const op of page.records) {
        // Pages run newest first, so everything past the first record older
        // than the intent is older still — including every later page.
        if (this.predatesIntent(intent, op.created_at)) {
          return { valid: false, reason: 'No matching payment found yet' };
        }
        if (!this.paymentMatches(intent, op)) {
          continue;
        }
        // Confirm success + memo on the owning transaction. The join already
        // put it in the page, so this resolves without a request.
        const tx = await op.transaction();
        if (!tx.successful) {
          continue;
        }
        if (!this.memoMatches(intent, tx.memo_type, tx.memo).ok) {
          continue;
        }
        const payer = (op as Horizon.ServerApi.PaymentOperationRecord).from;
        return { valid: true, txHash: op.transaction_hash, payer };
      }

      // A short page is the last one: the account has no older payments.
      if (page.records.length < PAYMENT_SCAN_PAGE_SIZE) {
        return { valid: false, reason: 'No matching payment found yet' };
      }
      if (pages >= PAYMENT_SCAN_MAX_PAGES) {
        this.logger.warn(
          `Payment scan for intent ${intent.id} stopped after ${pages} pages ` +
            `without reaching its creation time: ${intent.destination} has ` +
            'received more payments since than the scan reads. POST ' +
            '/:id/validate with the transaction hash settles it without a scan.',
        );
        return {
          valid: false,
          reason:
            `No matching payment among the ${pages * PAYMENT_SCAN_PAGE_SIZE} ` +
            'newest payments to the destination',
        };
      }
      page = await page.next();
    }
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
