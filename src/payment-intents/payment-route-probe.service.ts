import { Injectable, Logger } from '@nestjs/common';
import { ApiError } from '@/common/errors/api-error';
import type { PaymentRouteCheckEntity } from '@/payment-intents/entities/payment-deposit.entity';
import {
  type PricedIntentFields,
  PaymentDepositPricing,
} from '@/payment-intents/payment-deposit-pricing.service';
import {
  type CrossChainPayableFields,
  crossChainPaymentRefusal,
} from '@/payment-intents/payment-deposit-rules';
import {
  PAYMENT_ROUTE_PROBE_MAX_ENTRIES,
  PAYMENT_ROUTE_PROBE_ORIGINS,
  PAYMENT_ROUTE_PROBE_REFUND_TO,
  PAYMENT_ROUTE_PROBE_TTL_MS,
} from '@/payment-intents/payment-intents.constants';

/** The intent columns a route check reads. */
export type ProbedIntentFields = PricedIntentFields & CrossChainPayableFields;

/**
 * Whether the main origins (`PAYMENT_ROUTE_PROBE_ORIGINS`) can pay a link's
 * amount: one dry quote each, run together. Routes have minimums of their own
 * that change over time and are only told by refusing a quote, so this asks:
 * the dashboard warns the merchant about the origins that cannot pay the
 * amount (it never blocks the link), and the checkout disables them with the
 * reason before a payer picks one.
 *
 * Only for a link with a fixed amount that takes payments from another
 * network: an open amount's minimum depends on what the payer types, and the
 * quote tells them then. Answers are reused per asset and amount for
 * `PAYMENT_ROUTE_PROBE_TTL_MS`, in this process.
 */
@Injectable()
export class PaymentRouteProbe {
  private readonly logger = new Logger(PaymentRouteProbe.name);
  private readonly cache = new Map<
    string,
    { at: number; result: Promise<PaymentRouteCheckEntity[]> }
  >();

  constructor(private readonly pricing: PaymentDepositPricing) {}

  check(intent: ProbedIntentFields): Promise<PaymentRouteCheckEntity[]> {
    if (intent.amount === null || crossChainPaymentRefusal(intent) !== null) {
      return Promise.resolve([]);
    }
    const key = [
      intent.chain,
      intent.assetIssuer ?? intent.asset,
      intent.amount,
      intent.crossChainFeeBps,
      JSON.stringify(intent.merchantFee ?? null),
    ].join('|');
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < PAYMENT_ROUTE_PROBE_TTL_MS) return hit.result;

    const result = this.probe(intent);
    if (this.cache.size >= PAYMENT_ROUTE_PROBE_MAX_ENTRIES) {
      // Oldest first: a Map iterates in insertion order.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    const entry = { at: now, result: result.then((r) => r.routes) };
    this.cache.set(key, entry);
    // A probe that failed as a whole, or that could not ask an origin, is not
    // kept: the next check asks again.
    const forget = () => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    };
    result.then((r) => r.complete || forget(), forget);
    return entry.result;
  }

  private async probe(
    intent: ProbedIntentFields,
  ): Promise<{ routes: PaymentRouteCheckEntity[]; complete: boolean }> {
    const settled = await Promise.allSettled(
      PAYMENT_ROUTE_PROBE_ORIGINS.map((origin) =>
        this.pricing.price(
          intent,
          {
            originChain: origin.chain,
            originAsset: origin.asset,
            refundTo: PAYMENT_ROUTE_PROBE_REFUND_TO[origin.chain],
          },
          false,
        ),
      ),
    );
    const routes: PaymentRouteCheckEntity[] = [];
    let complete = true;
    settled.forEach((outcome, i) => {
      const { chain, asset } = PAYMENT_ROUTE_PROBE_ORIGINS[i];
      if (outcome.status === 'fulfilled') {
        routes.push({
          chain,
          asset,
          available: true,
          reason: null,
          amount: outcome.value.amountIn,
        });
        return;
      }
      const err: unknown = outcome.reason;
      // Only the route refusing (a minimum, a pair it does not quote) is an
      // answer, in its own words, already free of its name. A failure to ask
      // says nothing about the route: it is left out (never a false warning, never
      // an origin disabled for a blip) and logged, not shown.
      if (err instanceof ApiError && err.getStatus() < 500) {
        routes.push({
          chain,
          asset,
          available: false,
          reason: err.message,
          amount: null,
        });
        return;
      }
      complete = false;
      this.logger.warn(
        `Route check ${chain}/${asset} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return { routes, complete };
  }
}
