import { STATUS_CODES } from 'node:http';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

import {
  ApiError,
  defaultCodeForStatus,
  type ApiErrorBody,
  type ApiErrorDetails,
} from '@/common/errors/api-error';
import { neutralizeProviderNames } from '@/common/provider-names';

/**
 * Single, consistent error shape for every failure. HttpExceptions keep their
 * status/message; anything unexpected becomes a sanitized 500 (we never leak
 * stack traces or internal messages to the gateway/clients).
 *
 * No message leaves naming a provider, or an env var named after one
 * (`src/common/provider-names.ts`): throw sites say what failed in neutral
 * words, and this is the last line of defence for one that does not, and for
 * a provider's own reason relayed in a message. What it rewrites, and an
 * `ApiError`'s `operatorDetail`, go to the log instead.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'Internal Server Error';
    let code: string | undefined;
    let details: ApiErrorDetails | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const body = res as Record<string, unknown>;
        message = (body.message as string | string[]) ?? exception.message;
        // `error` is a reason phrase, and only a string is one. Terminus puts the
        // whole health report under `error` — for a failed readiness probe that
        // is Prisma's connection message, database host and user included — on
        // a `@Public()` route. A cast let that object through to the response.
        error =
          typeof body.error === 'string'
            ? body.error
            : (STATUS_CODES[status] ?? error);
        // Present when the throw site used ApiError; absent for a plain Nest
        // exception, which falls back to the status-derived code below so the
        // field is never missing from the envelope.
        if (typeof body.code === 'string') code = body.code;
      }
      // Read from the ApiError itself, never from the body: Terminus' readiness
      // report carries a `details` key of its own (the database's error among
      // it), and copying whatever an exception's body names would publish it.
      if (exception instanceof ApiError) {
        details = exception.details;
        if (exception.operatorDetail) {
          this.logger.warn(
            `${request.url} -> ${status}: ${exception.operatorDetail}`,
          );
        }
      }
    } else if (exception instanceof Error) {
      // Unexpected error: log full detail server-side, return generic to caller.
      this.logger.error(exception.message, exception.stack);
    }

    const neutral = neutralMessage(message);
    if (neutral !== message) {
      this.logger.warn(
        `${request.url} -> ${status}: ${JSON.stringify(message)}`,
      );
    }

    const body: ApiErrorBody = {
      statusCode: status,
      code: code ?? defaultCodeForStatus(status),
      error,
      message: neutral,
      ...(details ? { details: neutralDetails(details) } : {}),
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(body);
  }
}

/** `message` (one string, or a validation list) naming no provider. */
function neutralMessage(message: string | string[]): string | string[] {
  if (typeof message === 'string') return neutralizeProviderNames(message);
  const out = message.map((m) => neutralizeProviderNames(m));
  return out.every((m, i) => m === message[i]) ? message : out;
}

/** `details` with no provider named in its text; numbers and flags as they are. */
function neutralDetails(details: ApiErrorDetails): ApiErrorDetails {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      typeof value === 'string' ? neutralizeProviderNames(value) : value,
    ]),
  );
}
