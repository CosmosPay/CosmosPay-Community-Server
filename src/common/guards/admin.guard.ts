import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';

/**
 * Guards the platform-admin (global, cross-consumer) endpoints. ApisixGuard has
 * already proven the request came through the gateway (valid X-Gateway-Secret); this
 * additionally requires the trusted `X-Cosmos-Admin` marker. That header is **stripped
 * from any client request by APISIX** (it's on the route's proxy-rewrite remove list)
 * and is set ONLY by the dev platform's server-to-server admin proxy, which first
 * verifies the signed-in user is a platform owner/admin. So an external API-key caller
 * can never reach these unscoped, see-everything endpoints — only the owner console can.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const raw = request.headers['x-cosmos-admin'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value !== '1') {
      throw new ForbiddenException('Platform admin access required');
    }
    return true;
  }
}
