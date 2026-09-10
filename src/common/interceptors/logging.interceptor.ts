import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { finalize, tap } from 'rxjs/operators';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Structured per-request access log. Logs to the console and persists a
 * RequestLog row (best-effort) so the dashboard's "API logs" view can show real
 * requests with their details. Health probes are skipped to avoid noise.
 */
/**
 * Correlation id the wallet mints per request and sends as a header.
 *
 * Logged so one failure's two halves can be joined. The wallet reports `api.error` with a
 * status and a route; this line has the upstream's side of the same call. Pairing them by
 * timestamp works right up until two callers hit one route in the same second, which on
 * the routes that matter is most seconds.
 *
 * Kept in step with the wallet's `TRACE_HEADER` (its src/constants/telemetry.ts) and with
 * the gateway's CORS `allow_headers`, which must list it or the browser preflight fails
 * and the header never arrives at all.
 */
const TRACE_HEADER = 'x-cosmos-trace-id';

/**
 * Bound and sanitized, because this reaches a log line and a log line is a place
 * attacker-controlled bytes should never arrive raw: a newline would let a caller forge
 * an entire second log entry. Restricted to the id alphabet the wallet actually emits
 * (UUID, or its base36 fallback) and dropped rather than escaped if it is anything else.
 */
function firstHeader(request: Request, name: string): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return null;
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const { method } = request;
    const url = request.originalUrl || request.url;
    const startedAt = process.hrtime.bigint();
    const consumer = request.gatewayConsumer?.username ?? null;
    const traceId = firstHeader(request, TRACE_HEADER);

    // On the error path finalize() runs BEFORE AllExceptionsFilter writes the
    // response, so response.statusCode is still the untouched default (200 for
    // GET, 201 for POST). Capture the real status off the exception instead —
    // otherwise every failed request is logged, and persisted to RequestLog, as
    // a success, and the dashboard's API-log view can never show an error.
    let errorStatus: number | null = null;

    return next.handle().pipe(
      tap({
        error: (err: unknown) => {
          errorStatus = err instanceof HttpException ? err.getStatus() : 500;
        },
      }),
      finalize(() => {
        const elapsedMs =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const status = errorStatus ?? response.statusCode;
        this.logger.log(
          `${method} ${url} ${status} ${elapsedMs.toFixed(1)}ms consumer=${consumer ?? 'anonymous'}` +
            (traceId ? ` trace=${traceId}` : ''),
        );
        this.persist(request, url, status, Math.round(elapsedMs), consumer);
      }),
    );
  }

  /** Fire-and-forget write; never affects the response. Health checks excluded. */
  private persist(
    request: Request,
    url: string,
    statusCode: number,
    durationMs: number,
    consumer: string | null,
  ): void {
    const path = url.split('?')[0];
    if (path.startsWith('/v1/health') || path.startsWith('/docs')) return;
    // The dashboard's own management-console traffic is FLAGGED, not dropped.
    // This used to `return` here, which meant anyone who could set
    // `X-Cosmos-Internal` kept their requests out of the audit log entirely —
    // a request header must never be able to make traffic invisible. The
    // API-log view filters on the column instead (analytics.apiLogs).
    const internal = request.headers['x-cosmos-internal'] !== undefined;

    const ua = request.headers['user-agent'] as string | string[] | undefined;
    this.prisma.requestLog
      .create({
        data: {
          consumer,
          method: request.method,
          path,
          statusCode,
          durationMs,
          ip: request.ip ?? null,
          userAgent: Array.isArray(ua) ? ua[0] : (ua ?? null),
          internal,
        },
      })
      .catch(() => {
        /* logging must never break the request */
      });
  }
}
