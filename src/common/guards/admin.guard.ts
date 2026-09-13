import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { Request } from 'express';
import { resolveAdminPrincipal } from '@/admin/admin-auth';
import {
  ADMIN_ACTOR_ROLE_HEADER,
  ADMIN_INTERNAL_HEADER,
} from '@/admin/admin.constants';

/**
 * Platform-admin gate.
 *
 * ApisixGuard already proved the request carries the gateway secret and an
 * authenticated consumer. This guard adds the one fact that separates the
 * platform console from an API-key caller: the internal marker APISIX strips
 * from everything it proxies. Whether the human behind the console may be here
 * was decided there, against their account role — the same check that gates the
 * plan/role screens — so there is no second credential to deploy and no way for
 * the two answers to disagree. See {@link resolveAdminPrincipal} for the full
 * reasoning and the trade it makes.
 *
 * What the guard still owes is attribution: it attaches the console account as
 * `request.adminPrincipal`, which every audit row (reads included) is written
 * from.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    // The `declare module 'express'` augmentation widens `headers` to `any` in
    // files that also write to the augmented Request, so name the type here.
    const headers = request.headers as Record<
      string,
      string | string[] | undefined
    >;

    const principal = resolveAdminPrincipal({
      internal: headers[ADMIN_INTERNAL_HEADER],
      actorRole: headers[ADMIN_ACTOR_ROLE_HEADER],
      consumer: request.gatewayConsumer?.username,
    });

    if (!principal) {
      throw ApiError.forbidden(
        ApiErrorCode.AdminConsoleOnly,
        'This endpoint is reserved for the platform console',
      );
    }

    request.adminPrincipal = principal;
    return true;
  }
}
