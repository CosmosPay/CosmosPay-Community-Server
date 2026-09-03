import { Injectable, Logger } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { RateLimitPolicy } from '@/common/decorators/rate-limit.decorator';
import { RATE_LIMIT_GRACE_MS } from '@/common/rate-limit.constants';
import { PrismaService } from '@/prisma/prisma.service';

/** What one hit against a bucket did, and what the caller has left. */
export interface RateLimitOutcome {
  allowed: boolean;
  limit: number;
  /** Requests left in this window; never negative. */
  remaining: number;
  /** When the window rolls over and the budget resets. */
  resetAt: Date;
}

/**
 * A fixed-window counter shared by every replica through Postgres.
 *
 * **Why the database and not memory.** The service runs behind APISIX, which
 * load-balances across replicas, so a per-process counter hands each replica the
 * full budget: the effective limit becomes `limit x replicas`, and it changes
 * silently whenever the deployment scales. For a cosmetic throttle that is
 * tolerable. For the routes this actually guards — the ones that create and fund
 * Stellar accounts out of a real XLM balance — it is a funding-drain hole with a
 * scale factor on it.
 *
 * **Why fixed and not sliding.** One `INSERT … ON CONFLICT DO UPDATE …
 * RETURNING` is atomic, needs no lock, and costs a single round trip. The price
 * is the boundary burst: a client can spend its whole budget at the end of one
 * window and again at the start of the next, so the true worst case is `2 x
 * limit` over a window. Budgets below are set knowing that.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Counts one request against `subject` and reports whether it may proceed.
   *
   * Throws rather than failing open when the counter cannot be written: a
   * limiter that quietly stops limiting during a database incident is worth less
   * than no limiter, because nothing tells you it happened. It costs no
   * availability either — every route behind this one already needs the same
   * database to do its work.
   */
  async hit(
    subject: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitOutcome> {
    const now = Date.now();
    // Windows are aligned to the epoch rather than to first contact, so every
    // replica computes the same boundary for the same subject without
    // coordinating.
    const windowStart = new Date(
      Math.floor(now / policy.windowMs) * policy.windowMs,
    );
    const resetAt = new Date(windowStart.getTime() + policy.windowMs);
    const expiresAt = new Date(resetAt.getTime() + RATE_LIMIT_GRACE_MS);
    const key = `${policy.name}:${subject}`;

    let count: number;
    try {
      const rows = await this.prisma.$queryRaw<{ count: number }[]>`
        INSERT INTO "rate_limit_counter" ("key", "windowStart", "count", "expiresAt")
        VALUES (${key}, ${windowStart}, 1, ${expiresAt})
        ON CONFLICT ("key", "windowStart")
        DO UPDATE SET "count" = "rate_limit_counter"."count" + 1
        RETURNING "count"
      `;
      count = rows[0]?.count ?? 0;
    } catch (err) {
      this.logger.error(
        `Rate limit counter write failed for ${policy.name}; failing closed`,
        err as Error,
      );
      throw ApiError.unavailable(
        ApiErrorCode.ProviderUnavailable,
        'Rate limiting is temporarily unavailable. Retry shortly.',
      );
    }

    return {
      allowed: count <= policy.limit,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - count),
      resetAt,
    };
  }
}
