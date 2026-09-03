import { Injectable, Logger } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';
import { StellarService } from '@/stellar/stellar.service';
import { toStroops } from '@/swaps/swap-math';
import type { PaymentIntent } from '@generated/prisma/client';
import type { StellarNetwork } from '@/config/configuration';

export interface VerificationResult {
  valid: boolean;
  txHash?: string;
  reason?: string;
  /** The payer (source) account of the matched on-chain payment, when valid. */
  payer?: string;
}

/**
 * Confirms that an on-chain Stellar transaction actually fulfills a payment
 * intent: it must be successful, contain a payment to the intent's destination
 * in the intent's asset for the exact amount, and the transaction memo must
 * match. Each intent carries its own `network` (derived from the API key type),
 * so all Horizon calls target that network. Used both by the manual `validate`
 * endpoint and the permanent observer, so the rule lives in one place.
 */
@Injectable()
export class StellarVerifierService {
  private readonly logger = new Logger(StellarVerifierService.name);

  constructor(private readonly stellar: StellarService) {}

  private server(intent: PaymentIntent): Horizon.Server {
    return this.stellar.server(intent.network as StellarNetwork);
  }

  /** Verifies a specific transaction hash against the intent. */
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

    if (!tx.successful) {
      return { valid: false, reason: 'Transaction failed on-chain' };
    }

    const memoCheck = this.memoMatches(intent, tx.memo_type, tx.memo);
    if (!memoCheck.ok) {
      return { valid: false, reason: memoCheck.reason };
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
