import { ApiError, ApiErrorCode } from '@/common/errors/api-error';

/** The configured slippage policy both envelope builders apply. */
export interface SlippagePolicy {
  /** Applied when the caller names no tolerance. */
  slippageBps: number;
  /** The most a caller may ask for, so they cannot sign away an unbounded loss. */
  maxSlippageBps: number;
}

/**
 * Caller slippage, defaulted and clamped to the configured maximum.
 *
 * Swaps and liquidity pools each carried a private copy, the pools one reading
 * "defaulted and clamped like swaps (same settings)" — a promise that held only
 * as long as nobody edited one copy. Both flows read the same
 * `STELLAR_SWAP_*_SLIPPAGE_BPS` settings, so the rule is one function.
 *
 * A request over the cap is refused rather than silently clamped: the caller
 * asked for a tolerance, and pricing an envelope at a different one would hand
 * them terms they did not agree to.
 */
export function resolveSlippage(
  requested: number | undefined,
  policy: SlippagePolicy,
): number {
  const bps = requested ?? policy.slippageBps;
  if (bps > policy.maxSlippageBps) {
    throw ApiError.badRequest(
      ApiErrorCode.SlippageExceeded,
      `slippageBps ${bps} exceeds the maximum allowed (${policy.maxSlippageBps})`,
    );
  }
  return bps;
}

/**
 * The request's `Idempotency-Key`: the header wins over the body field, and a
 * blank string is treated as absent.
 *
 * Blank-as-absent matters because a key is a unique index with the consumer: an
 * empty-string key would make every keyless retry from that consumer "the same
 * request" and replay the first one. Header-over-body is the documented contract
 * on every route that takes a key, which is why it lives with the other shared
 * envelope rules rather than in each service.
 */
export function resolveIdempotencyKey(
  header?: string,
  body?: string,
): string | null {
  const raw = (header ?? body)?.trim();
  return raw ? raw : null;
}
