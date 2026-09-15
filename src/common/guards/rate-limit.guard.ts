import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { clientIp, rateLimitSubject } from '@/common/client-ip';
import {
  RATE_LIMIT_KEY,
  RateLimitPolicy,
} from '@/common/decorators/rate-limit.decorator';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { RATE_LIMIT_HEADER } from '@/common/rate-limit.constants';
import {
  RateLimitOutcome,
  RateLimitService,
} from '@/common/services/rate-limit.service';
import { AppConfig } from '@/config/configuration';

/**
 * Enforces the budgets a route declares with `@RateLimit`.
 *
 * Opt-in, unlike the other two global guards: a route with no policy passes
 * straight through after one reflector read. That is deliberate — this is not a
 * traffic shaper (APISIX is, and it sees the request first), it is a cap on
 * handlers whose cost cannot be refunded by returning an error later.
 *
 * Registered *after* `ApisixGuard` and `PermissionsGuard`, so a request that was
 * never going to be served does not spend a legitimate address's budget on its
 * way to a 403.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly enabled: boolean;

  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled = config.get('rateLimit', { infer: true }).enabled;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policies = this.reflector.getAllAndOverride<RateLimitPolicy[]>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!policies?.length || !this.enabled) {
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    // Keyed by consumer as well as address so one integrator's traffic cannot
    // eat another's budget, and so a shared NAT is at least partitioned by who
    // is calling. The address is still the part doing the work, except for a
    // `per: 'consumer'` ceiling, which exists precisely so it is not.
    const consumer = request.gatewayConsumer?.username ?? 'anonymous';
    const address = rateLimitSubject(clientIp(request));

    // The tightest budget is the one reported, so a client pacing itself on
    // these headers slows down for the limit it will actually hit first.
    let tightest: RateLimitOutcome | null = null;
    for (const policy of policies) {
      const perConsumer = policy.per === 'consumer';
      // The console brokers every keyless wallet through one consumer and
      // budgets that traffic itself; a per-consumer ceiling here would throttle
      // all of them together.
      if (perConsumer && request.gatewayConsumer?.internal) continue;

      const subject = perConsumer ? consumer : `${consumer}:${address}`;
      const outcome = await this.limiter.hit(subject, policy);

      if (!outcome.allowed) {
        const resetSeconds = this.report(response, outcome);
        response.setHeader(RATE_LIMIT_HEADER.retryAfter, resetSeconds);
        // The address is what was throttled and the operator needs it to tell
        // an attack from a misconfigured integrator, but it is also the payer's
        // IP — the same value `RequestLog` keeps and prunes. It stays in the log
        // and never goes back to the caller.
        this.logger.warn(
          `Rate limit ${policy.name} exceeded by ${consumer} from ${clientIp(request)}`,
        );
        throw new ApiError(
          429,
          ApiErrorCode.RateLimited,
          `Too many requests. Retry in ${resetSeconds}s.`,
        );
      }

      if (!tightest || outcome.remaining < tightest.remaining) {
        tightest = outcome;
      }
    }

    if (tightest) this.report(response, tightest);
    return true;
  }

  /** Puts one bucket's budget on the response; returns seconds until it resets. */
  private report(response: Response, outcome: RateLimitOutcome): number {
    const resetSeconds = Math.max(
      0,
      Math.ceil((outcome.resetAt.getTime() - Date.now()) / 1000),
    );
    response.setHeader(RATE_LIMIT_HEADER.limit, outcome.limit);
    response.setHeader(RATE_LIMIT_HEADER.remaining, outcome.remaining);
    response.setHeader(RATE_LIMIT_HEADER.reset, resetSeconds);
    return resetSeconds;
  }
}
