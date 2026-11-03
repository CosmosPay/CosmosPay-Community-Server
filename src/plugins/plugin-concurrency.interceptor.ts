import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { type Observable, throwError } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { RATE_LIMIT_HEADER } from '@/common/rate-limit.constants';
import { PluginConcurrencyService } from '@/plugins/plugin-concurrency.service';
import { PLUGIN_BUSY_RETRY_AFTER_SECONDS } from '@/plugins/plugins.constants';

/**
 * Holds a plugin slot for the whole of one action request
 * (`PluginConcurrencyService`), or refuses it with `429 rate_limited` and
 * `Retry-After`, the answer the route's per-minute budget already gives: the
 * caller backs off the same way either way.
 */
@Injectable()
export class PluginConcurrencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(PluginConcurrencyInterceptor.name);

  constructor(private readonly concurrency: PluginConcurrencyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const consumer =
      http.getRequest<Request>().gatewayConsumer?.username ?? 'anonymous';
    const release = this.concurrency.tryEnterAction(consumer);
    if (!release) {
      http
        .getResponse<Response>()
        .setHeader(
          RATE_LIMIT_HEADER.retryAfter,
          PLUGIN_BUSY_RETRY_AFTER_SECONDS,
        );
      this.logger.warn(
        `Plugin call refused: ${consumer} or this process has every plugin slot in use`,
      );
      return throwError(
        () =>
          new ApiError(
            429,
            ApiErrorCode.RateLimited,
            `Too many plugin calls in flight. Retry in ${PLUGIN_BUSY_RETRY_AFTER_SECONDS}s.`,
          ),
      );
    }
    return next.handle().pipe(finalize(release));
  }
}
