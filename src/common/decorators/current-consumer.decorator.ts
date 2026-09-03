import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { Request } from 'express';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';

/**
 * Injects the gateway-authenticated consumer into a handler argument.
 *
 *   @Get()
 *   list(@CurrentConsumer() consumer: GatewayConsumer) { ... }
 *
 * Reaching a non-public handler without a consumer means the guard/middleware
 * pipeline was bypassed — that's a server bug, hence the 500.
 */
export const CurrentConsumer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): GatewayConsumer => {
    const request = ctx.switchToHttp().getRequest<Request>();

    if (!request.gatewayConsumer) {
      throw new InternalServerErrorException(
        'No gateway consumer on request — was ApisixGuard applied?',
      );
    }

    return request.gatewayConsumer;
  },
);
