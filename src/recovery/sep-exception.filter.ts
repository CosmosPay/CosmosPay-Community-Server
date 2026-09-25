import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Errors on the SEP-10 and SEP-30 routes, in the standards' shape:
 * `{ "error": "..." }` and a status.
 *
 * Everything else in this API answers with its own envelope, and that is right
 * for endpoints this API invented. These are endpoints someone else's client
 * calls: a SEP-30 wallet reads `error`, and handed `{ statusCode, code, message }`
 * it reads undefined and reports "the server said nothing". Bound per controller,
 * so it wins over the global filter here and nowhere else.
 *
 * Validation failures arrive as Nest's 400 with an array of messages; they are
 * joined, because SEP's `error` is one string. An unexpected error is a 500 with
 * nothing of its detail in the body — logged here, never returned.
 */
@Catch()
export class SepExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SepExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      let error = exception.message;
      if (typeof body === 'string') {
        error = body;
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        if (
          typeof b.error === 'string' &&
          status !== Number(HttpStatus.BAD_REQUEST)
        )
          error = b.error;
        else if (Array.isArray(b.message)) error = b.message.join('; ');
        else if (typeof b.message === 'string') error = b.message;
        else if (typeof b.error === 'string') error = b.error;
      }
      response.status(status).json({ error });
      return;
    }

    this.logger.error(
      exception instanceof Error ? exception.message : String(exception),
      exception instanceof Error ? exception.stack : undefined,
    );
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ error: 'Internal server error.' });
  }
}
