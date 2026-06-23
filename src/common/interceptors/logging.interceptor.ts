import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Structured per-request access log. Logs to the console and persists a
 * RequestLog row (best-effort) so the dashboard's "API logs" view can show real
 * requests with their details. Health probes are skipped to avoid noise.
 */
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

    return next.handle().pipe(
      finalize(() => {
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const status = response.statusCode;
        this.logger.log(
          `${method} ${url} ${status} ${elapsedMs.toFixed(1)}ms consumer=${consumer ?? 'anonymous'}`,
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

    const ua = request.headers['user-agent'];
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
        },
      })
      .catch(() => {
        /* logging must never break the request */
      });
  }
}
