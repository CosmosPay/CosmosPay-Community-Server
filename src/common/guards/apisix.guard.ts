import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { AppConfig } from '../../config/configuration';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * The gatekeeper. A request is only accepted when:
 *
 *   1. It carries the shared gateway secret header (X-Gateway-Secret) whose
 *      value matches APISIX_GATEWAY_SECRET. APISIX injects this header on every
 *      proxied request *and strips any client-supplied copy*, so a correct
 *      value can only originate from the gateway. Compared in constant time.
 *
 *   2. It carries a consumer identity (X-Consumer-Username), proving APISIX's
 *      `key-auth` plugin already authenticated the caller's API key.
 *
 * Routes annotated with @Public() skip this check. Enforcement is always on:
 * every non-public route must arrive through the gateway (valid X-Gateway-Secret
 * + an authenticated consumer). There is no opt-out flag.
 */
@Injectable()
export class ApisixGuard implements CanActivate {
  private readonly logger = new Logger(ApisixGuard.name);
  private readonly secretBuffer: Buffer;

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    this.secretBuffer = Buffer.from(
      this.config.get('apisix', { infer: true }).gatewaySecret,
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const apisix = this.config.get('apisix', { infer: true });
    const request = context.switchToHttp().getRequest<Request>();

    // 1. Verify the gateway shared secret (constant-time).
    if (!this.hasValidSecret(request, apisix.gatewaySecretHeader)) {
      this.logger.warn(
        `Rejected request to ${request.method} ${request.url}: missing/invalid gateway secret`,
      );
      throw new ForbiddenException(
        'Request did not originate from the gateway',
      );
    }

    // 2. Verify APISIX forwarded an authenticated consumer.
    if (!request.gatewayConsumer?.username) {
      this.logger.warn(
        `Rejected request to ${request.method} ${request.url}: no authenticated consumer`,
      );
      throw new UnauthorizedException('No authenticated consumer');
    }

    return true;
  }

  private hasValidSecret(request: Request, headerName: string): boolean {
    if (this.secretBuffer.length === 0) {
      // Should be impossible: env validation requires APISIX_GATEWAY_SECRET at
      // boot. Fail closed rather than accidentally trusting everything.
      throw new ServiceUnavailableException('Gateway secret not configured');
    }

    const raw = request.headers[headerName];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (!provided) {
      return false;
    }

    const providedBuffer = Buffer.from(provided);
    if (providedBuffer.length !== this.secretBuffer.length) {
      return false;
    }

    return timingSafeEqual(providedBuffer, this.secretBuffer);
  }
}
