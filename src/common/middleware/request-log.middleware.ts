import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Structured per-request access log. Logs to the console and persists a
 * RequestLog row (best-effort) so the dashboard's "API logs" view can show real
 * requests with their real outcome.
 *
 * This lives in a middleware — not an interceptor — on purpose. Middlewares run
 * before guards, so the `res.on('finish')` listener is armed even for requests
 * that `ApisixGuard` / `PermissionsGuard` reject (403/401), which never reach an
 * interceptor. And because we read `res.statusCode` at `finish` time — after
 * AllExceptionsFilter has written the response — the status is the definitive
 * one, instead of Express's 200 default that the old interceptor captured too
 * early. Health probes and docs traffic are skipped to keep the log signal-only.
 */
@Injectable()
export class RequestLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly prisma: PrismaService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    const method = req.method;
    const url = req.originalUrl || req.url;

    // `finish` fires once the response is fully flushed; `close` covers a client
    // that hangs up early (no `finish`). The guard makes sure we write at most
    // one row even when both fire.
    let written = false;
    const record = (): void => {
      if (written) return;
      written = true;

      if (this.shouldSkip(req, url)) return;

      const elapsedMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const status = res.statusCode;
      const consumer = req.gatewayConsumer?.username ?? null;

      this.logger.log(
        `${method} ${url} ${status} ${elapsedMs.toFixed(1)}ms consumer=${consumer ?? 'anonymous'}`,
      );
      this.persist(req, url, status, Math.round(elapsedMs), consumer);
    };

    res.on('finish', record);
    res.on('close', record);

    next();
  }

  /**
   * Health probes, docs traffic and the dashboard's own management-console calls
   * (marked with `x-cosmos-internal`) never belong in the API log: it should
   * only show real API-key usage. Skipping here keeps the console line and the
   * persisted row consistent — both are omitted together.
   */
  private shouldSkip(request: Request, url: string): boolean {
    const path = url.split('?')[0];
    if (path.startsWith('/v1/health') || path.startsWith('/docs')) return true;
    if (request.headers['x-cosmos-internal']) return true;
    return false;
  }

  /** Fire-and-forget write; must never break or delay the response. */
  private persist(
    request: Request,
    url: string,
    statusCode: number,
    durationMs: number,
    consumer: string | null,
  ): void {
    const path = url.split('?')[0];
    const ua = request.headers['user-agent'];
    try {
      const result = this.prisma.requestLog.create({
        data: {
          consumer,
          method: request.method,
          path,
          statusCode,
          durationMs,
          ip: request.ip ?? null,
          userAgent: Array.isArray(ua) ? ua[0] : (ua ?? null),
        },
      });
      // Guard both a rejected promise and a non-thenable (e.g. a test mock):
      // logging must never surface an error onto the request path.
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void (result as Promise<unknown>).catch(() => {
          /* best-effort: a failed log write must not affect the request */
        });
      }
    } catch {
      /* best-effort: never let logging break the request */
    }
  }
}
