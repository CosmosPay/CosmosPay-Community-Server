import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  ANY_PERMISSIONS_KEY,
  PERMISSIONS_KEY,
} from '../decorators/require-permissions.decorator';

/**
 * Authorizes a request against the API key's granted scopes.
 *
 * API keys are a permission system independent from the developer dashboard:
 * each key carries a role + a set of scopes (e.g. `payments:read`,
 * `payments:write`) that APISIX forwards downstream (X-Consumer-Role /
 * X-Consumer-Permissions). A handler declares what it needs with
 * @RequirePermissions(...). The rules:
 *
 *   - @Public() route → skipped.
 *   - No @RequirePermissions on the handler → no scope check.
 *   - A scoped route reached without an authenticated consumer → denied (fail
 *     closed). In practice ApisixGuard already rejects these first.
 *   - `admin` role → always allowed (full access).
 *   - otherwise → the key must hold every required scope.
 *
 * Always enforced — there is no opt-out flag. Runs after ApisixGuard, which has
 * already proven the request came from the gateway and carries a consumer.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const required =
      this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    const requiredAny =
      this.reflector.getAllAndOverride<string[]>(ANY_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (required.length === 0 && requiredAny.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const consumer = request.gatewayConsumer;

    // A scoped route reached without an authenticated consumer is denied (fail
    // closed). ApisixGuard normally rejects these first; this is defense in depth.
    if (!consumer) {
      this.logger.warn(
        `Rejected ${request.method} ${request.url}: no authenticated consumer for a scoped route`,
      );
      throw new UnauthorizedException('No authenticated consumer');
    }

    // admin keys have full access.
    if (consumer.role === 'admin') {
      return true;
    }

    const granted = new Set(consumer.permissions ?? []);
    const missing = required.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      this.logger.warn(
        `Rejected ${request.method} ${request.url}: missing scope(s) ${missing.join(', ')}`,
      );
      throw new ForbiddenException(
        `This API key is missing the required scope(s): ${missing.join(', ')}`,
      );
    }

    // "Any of" set: the key must hold at least one of these scopes.
    if (requiredAny.length > 0 && !requiredAny.some((s) => granted.has(s))) {
      this.logger.warn(
        `Rejected ${request.method} ${request.url}: needs one of ${requiredAny.join(', ')}`,
      );
      throw new ForbiddenException(
        `This API key needs at least one of the scope(s): ${requiredAny.join(', ')}`,
      );
    }

    return true;
  }
}
