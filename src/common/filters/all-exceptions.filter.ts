import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { defaultCodeForStatus, type ApiErrorBody } from '../errors/api-error';

/**
 * Single, consistent error shape for every failure. HttpExceptions keep their
 * status/message; anything unexpected becomes a sanitized 500 (we never leak
 * stack traces or internal messages to the gateway/clients).
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

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const body = res as Record<string, unknown>;
        message = (body.message as string | string[]) ?? exception.message;
        error = (body.error as string) ?? error;
        // Present when the throw site used ApiError; absent for a plain Nest
        // exception, which falls back to the status-derived code below so the
        // field is never missing from the envelope.
        if (typeof body.code === 'string') code = body.code;
      }
    } else if (exception instanceof Error) {
      // Unexpected error: log full detail server-side, return generic to caller.
      this.logger.error(exception.message, exception.stack);
    }

    const body: ApiErrorBody = {
      statusCode: status,
      code: code ?? defaultCodeForStatus(status),
      error,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(body);
  }
}
