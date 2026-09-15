import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { isInternalCall } from '@/admin/admin-auth';
import { ADMIN_INTERNAL_HEADER } from '@/admin/admin.constants';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';

/**
 * Admits only calls from the platform console, on a route that is not part of
 * the admin surface but whose response must never reach an API-key caller.
 *
 * The test is the one `AdminGuard` applies, without the admin principal:
 * `ApisixGuard` has already verified the gateway secret, and the internal marker
 * is a header APISIX strips from everything it proxies — so only a backend that
 * holds the gateway secret can present it. See `resolveAdminPrincipal` for the
 * trade that rests on.
 *
 * The first route behind it is alias recovery. Its response carries the token
 * that stands for control of the owner's mailbox; the console delivers it by
 * email, and anyone else holding it could take the alias — and every payment
 * sent to that name — with a signature from a key of their own.
 *
 * Route-scoped with `@UseGuards`, so it runs after the global guards.
 */
@Injectable()
export class ConsoleOnlyGuard implements CanActivate {
  private readonly logger = new Logger(ConsoleOnlyGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    // The `declare module 'express'` augmentation widens `headers` to `any` in
    // files that also write to the augmented Request, so name the type here.
    const headers = request.headers as Record<
      string,
      string | string[] | undefined
    >;

    if (!isInternalCall(headers[ADMIN_INTERNAL_HEADER])) {
      // A refusal in a guard never reaches the access log (interceptors run
      // after guards), and an API key asking for a recovery token is exactly the
      // attempt worth seeing.
      this.logger.warn(
        `Rejected ${request.method} ${request.url}: not a platform-console call (consumer=${request.gatewayConsumer?.username ?? 'none'})`,
      );
      throw ApiError.forbidden(
        ApiErrorCode.AdminConsoleOnly,
        'This endpoint is reserved for the platform console',
      );
    }
    return true;
  }
}
