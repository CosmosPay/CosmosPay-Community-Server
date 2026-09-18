import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

export const RATE_LIMIT_KEY = 'rateLimitPolicy';

/**
 * Vendor extension the published spec carries: the route's budgets, verbatim.
 *
 * `swagger.ts` reads it back to decide which operations can answer 429 — the
 * spec used to document that status on all ~107 of them, with a description
 * that admitted only some could return it. It is published rather than kept
 * internal because a client that has to pace itself cannot read our source,
 * and a limit discovered by being refused is one discovered in production.
 */
export const RATE_LIMIT_EXTENSION_KEY = 'x-cosmos-rate-limit';

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
  /**
   * Who the budget belongs to.
   *
   *   - `address` (the default) counts per consumer per client address, which
   *     tells one ordinary caller from another.
   *   - `consumer` counts per consumer alone: a ceiling no amount of address
   *     rotation gets past, for spend one tenant must not be able to multiply.
   *
   * A platform-console call (`X-Cosmos-Internal`) is exempt from `consumer`
   * budgets, because the dev platform brokers every keyless wallet through one
   * consumer and enforces its own global budgets in front of it. Never put a
   * `consumer` budget on a `@Public()` route: every anonymous caller is the
   * same `anonymous` subject there.
   */
  per?: 'address' | 'consumer';
}

/**
 * Caps how often one client address — or one consumer — may reach a handler.
 *
 * Enforced by `RateLimitGuard` against a shared Postgres counter, keyed by
 * policy name + consumer, plus the client address unless the policy is `per:
 * 'consumer'` (an IPv6 caller is bucketed per /64 — see `rateLimitSubject`). A
 * route with no `@RateLimit` is not limited here at all; the gateway's own
 * throttling is the only thing in front of it.
 *
 *   @RateLimit(POLLAR_AUTHORIZE_RATE_LIMIT, POLLAR_WALLET_DAILY_RATE_LIMIT)
 *   authorize(...) { ... }
 *
 * Several policies may be stacked on one route, typically a per-address budget
 * and a per-consumer ceiling. Every one is counted, and the first one spent
 * refuses the request.
 *
 * Reach for it where a request costs something that cannot be undone by
 * returning an error — money spent, an account created on a chain, an email
 * sent, a provider quota other tenants share — rather than as a general traffic
 * shaper. That job belongs to APISIX, which sees the request before it reaches
 * this process at all.
 */
export const RateLimit = (...policies: RateLimitPolicy[]) =>
  applyDecorators(
    SetMetadata(RATE_LIMIT_KEY, policies),
    ApiExtension(RATE_LIMIT_EXTENSION_KEY, policies),
  );
