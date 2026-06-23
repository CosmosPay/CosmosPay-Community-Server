import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AppConfig } from '../../config/configuration';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';

/**
 * Authorizes a request against the API key's granted scopes.
 *
 * API keys are a permission system independent from the developer dashboard:
 * each key carries a role + a set of scopes (e.g. `read`, `write`) that APISIX
 * forwards downstream (X-Consumer-Role / X-Consumer-Permissions). A handler
 * declares what it needs with @RequirePermissions(...). The rules:
 *
 *   - No @RequirePermissions on the handler → no scope check (auth still done by
 *     ApisixGuard).
 *   - `admin` role → always allowed (full access).
 *   - otherwise → the key must hold every required scope.
 *
 * Runs after ApisixGuard (which has already proven the request came from the
 * gateway and carries a consumer). Disabled entirely when ENFORCE_GATEWAY=false
 * so local development without the gateway isn't blocked.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const apisix = this.config.get('apisix', { infer: true });
    if (!apisix.enforce) {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const consumer = request.gatewayConsumer;

    // admin keys have full access.
    if (consumer?.role === 'admin') {
      return true;
    }

    const granted = new Set(consumer?.permissions ?? []);
    const missing = required.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      this.logger.warn(
        `Rejected ${request.method} ${request.url}: missing scope(s) ${missing.join(', ')}`,
      );
      throw new ForbiddenException(
        `This API key is missing the required scope(s): ${missing.join(', ')}`,
      );
    }

    return true;
  }
}
