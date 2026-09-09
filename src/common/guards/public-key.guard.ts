import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AppConfig } from '@/config/configuration';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { ALLOW_PUBLIC_KEY } from '@/common/decorators/allow-public-key.decorator';
import { IS_PUBLIC_KEY } from '@/common/decorators/public.decorator';

/**
 * Confines the shared public API key to the handlers that explicitly admit it.
 *
 * Runs after PermissionsGuard, and narrows rather than widens: a public consumer
 * still needs every scope its route requires, and this refuses it anywhere the
 * route is not marked `@AllowPublicKey()`. Every other consumer passes straight
 * through — this guard has no opinion about ordinary keys.
 *
 * Two independent signals identify the public consumer, because either one alone
 * fails open in a way that costs user data:
 *
 *   1. The role APISIX forwards (`X-Consumer-Role: public`), derived from the
 *      key's own labels — the same channel that already carries its scopes.
 *   2. The configured consumer username (`APISIX_PUBLIC_CONSUMER`), which holds
 *      even if the role header is dropped by a misconfigured route or an
 *      upgrade that resets a plugin.
 *
 * Signal 1 without 2 means a gateway that stops forwarding roles quietly promotes
 * every anonymous caller to a normal key. Signal 2 without 1 means the same for a
 * deployment where nobody set the env var. Requiring EITHER to match is what makes
 * the two failures independent instead of sequential.
 *
 * Note what this guard does not do: it does not care whether the route is a read
 * or a write. `POST /v1/swaps` is fine for the public key (it builds an envelope
 * from the request) while `GET /v1/swaps` is not (it replays what the consumer
 * wrote). The distinction is tenancy, not the HTTP verb, which is why it is
 * declared per handler rather than inferred.
 */
@Injectable()
export class PublicKeyGuard implements CanActivate {
  private readonly logger = new Logger(PublicKeyGuard.name);

  /** Read once: the consumer username is fixed for the process lifetime. */
  private readonly publicConsumer: string;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService<AppConfig, true>,
  ) {
    this.publicConsumer = config.get('apisix', { infer: true }).publicConsumer;
  }

  canActivate(context: ExecutionContext): boolean {
    const isPublicRoute = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublicRoute) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const consumer = request.gatewayConsumer;
    if (!consumer || !this.isPublicConsumer(consumer.username, consumer.role)) {
      return true;
    }

    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) {
      return true;
    }

    this.logger.warn(
      `Rejected ${request.method} ${request.url}: the shared public key may not reach this route`,
    );
    throw ApiError.forbidden(
      ApiErrorCode.InsufficientScope,
      'This endpoint is not available to the shared public API key. Create a ' +
        'CosmosPay account to get your own key — which also lowers your swap ' +
        'commission below the public rate.',
    );
  }

  private isPublicConsumer(username: string, role: string | null): boolean {
    if (role === 'public') return true;
    return !!this.publicConsumer && username === this.publicConsumer;
  }
}
