import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rateLimitPolicy';

/** What a route is allowed, and over what span. */
export interface RateLimitPolicy {
  /**
   * Bucket name. Routes that should share one budget share a name; everything
   * else gets its own. It is part of the counter key, so renaming it resets
   * every live bucket — which is fine, and occasionally what you want.
   */
  name: string;
  /** Requests permitted per window, per subject. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Caps how often one client address may reach a handler.
 *
 * Enforced by `RateLimitGuard` against a shared Postgres counter, keyed by
 * policy name + consumer + client address (an IPv6 caller is bucketed per /64 —
 * see `rateLimitSubject`). A route with no `@RateLimit` is not limited here at
 * all; the gateway's own throttling is the only thing in front of it.
 *
 *   @RateLimit(POLLAR_AUTHORIZE_RATE_LIMIT)
 *   authorize(...) { ... }
 *
 * Reach for it where a request costs something that cannot be undone by
 * returning an error — money spent, an account created on a chain, an email
 * sent — rather than as a general traffic shaper. That job belongs to APISIX,
 * which sees the request before it reaches this process at all.
 */
export const RateLimit = (policy: RateLimitPolicy) =>
  SetMetadata(RATE_LIMIT_KEY, policy);
