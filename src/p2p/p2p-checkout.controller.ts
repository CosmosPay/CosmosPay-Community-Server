import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { clientIp } from '@/common/client-ip';
import { ApiErrorCode } from '@/common/errors/api-error';
import { RATE_LIMIT_HEADER } from '@/common/rate-limit.constants';
import { headerValue } from '@/common/request-header';
import { CreateP2pCheckoutOrderDto } from '@/p2p/dto/p2p-charge.dto';
import { ReportP2pMarketPaidDto } from '@/p2p/dto/p2p-order.dto';
import {
  P2pCheckoutChargeEntity,
  P2pCheckoutCreatedOrderEntity,
  P2pCheckoutOrderEntity,
} from '@/p2p/entities/p2p-charge.entity';
import {
  P2pChargeIdParam,
  P2pNetworkRefusal,
  P2pNoMatchResponse,
} from '@/p2p/p2p-api-docs';
import {
  P2pCheckoutBudgetError,
  P2pCheckoutService,
} from '@/p2p/p2p-checkout.service';
import {
  P2P_CHECKOUT_ACTION_RATE_LIMIT,
  P2P_CHECKOUT_ORDER_RATE_LIMIT,
  P2P_CHECKOUT_READ_RATE_LIMIT,
} from '@/p2p/p2p.constants';

const NO_STORE = {
  'Cache-Control': {
    description: 'Always `no-store`: the status changes live.',
    schema: { type: 'string', example: 'no-store' },
  },
};

const PAYER_TOKEN = ApiHeader({
  name: 'X-Payer-Token',
  required: true,
  description:
    'The `payerToken` the order was created with. A missing or wrong token is the 404 of a missing order.',
});

const ORDER_ID = ApiParam({
  name: 'id',
  description: 'The order id, as its creation answered it.',
  example: '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10',
});

/**
 * `/v1/p2p-checkout`: the payer's half of a P2P charge, with no API key.
 *
 * Its own prefix, apart from `/v1/p2p`, because the gateway serves keyless
 * routes as a prefix route, which only works when nothing under the prefix
 * needs a key. `@Public()`: there is no consumer here (`ApisixGuard` drops any
 * the client names), every budget is per client address, the charge id only
 * reads the charge and starts an order within its budgets, and the order's
 * routes take its payer token. This service writes no CORS headers; the gateway
 * route adds them.
 */
@ApiTags('p2p-checkout')
@Controller({ path: 'p2p-checkout', version: '1' })
export class P2pCheckoutController {
  constructor(private readonly checkout: P2pCheckoutService) {}

  @Get('charges/:id')
  @Public()
  @RateLimit(P2P_CHECKOUT_READ_RATE_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read a charge as its payer sees it (no API key)',
    description:
      'Called without an API key, by the hosted payer page: the amount in local money, the description, the status and the rails a merchant takes for it right now. Nothing about who created it. Budgeted per client address.',
  })
  @P2pChargeIdParam()
  @ApiOkResponse({ type: P2pCheckoutChargeEntity, headers: NO_STORE })
  getCharge(@Param('id') id: string) {
    return this.checkout.getCharge(id);
  }

  @Post('charges/:id/orders')
  @Public()
  @RateLimit(P2P_CHECKOUT_ORDER_RATE_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Start paying a charge: a merchant to transfer to, and a payer token (no API key)',
    description:
      'Called without an API key, with the payer’s name, document and email: a merchant is matched for the exact amount on the chosen rail and the order is opened for the charge’s recipient. The answer has where to transfer, the deadline, and `payerToken` (shown once) for the order’s routes. One payer at a time per charge unless it is multi-use (`409 operation_in_flight`), one live order per client address, and a limited number of new orders per charge (`429` with `Retry-After`).',
  })
  @P2pChargeIdParam()
  @ApiCreatedResponse({
    type: P2pCheckoutCreatedOrderEntity,
    headers: NO_STORE,
  })
  @ApiUpstream('EVM network')
  @P2pNetworkRefusal()
  @P2pNoMatchResponse(
    ApiErrorCode.OperationInFlight,
    ApiErrorCode.RequestClosed,
  )
  @ApiErrorResponse({
    status: 429,
    codes: [ApiErrorCode.RateLimited],
    description:
      'The charge took its share of new orders for now, or this client spent its budget. Honour `Retry-After`.',
  })
  createOrder(
    @Param('id') id: string,
    @Body() dto: CreateP2pCheckoutOrderDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<P2pCheckoutCreatedOrderEntity> {
    return this.checkout
      .createOrder(id, dto, clientIp(req))
      .catch((err: unknown) => {
        if (err instanceof P2pCheckoutBudgetError) {
          res.setHeader(RATE_LIMIT_HEADER.retryAfter, err.retryAfterSeconds);
        }
        throw err;
      });
  }

  @Get('orders/:id')
  @Public()
  @RateLimit(P2P_CHECKOUT_READ_RATE_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read your order with its payer token (no API key)',
    description:
      'Called without an API key, with `X-Payer-Token`: the amount, where to transfer while the order is live, the deadline and the status to poll. Budgeted per client address.',
  })
  @ORDER_ID
  @PAYER_TOKEN
  @ApiOkResponse({ type: P2pCheckoutOrderEntity, headers: NO_STORE })
  getOrder(@Param('id') id: string, @Req() req: Request) {
    return this.checkout.getOrder(id, headerValue(req, 'x-payer-token'));
  }

  @Post('orders/:id/paid')
  @Public()
  @RateLimit(P2P_CHECKOUT_ACTION_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Report that you sent the transfer (no API key)',
    description:
      'Called without an API key, with `X-Payer-Token`: the order is marked paid on-chain for you, with your transfer `reference` for the merchant. The merchant then checks its bank and releases.',
  })
  @ORDER_ID
  @PAYER_TOKEN
  @ApiOkResponse({ type: P2pCheckoutOrderEntity, headers: NO_STORE })
  @ApiUpstream('EVM network')
  @P2pNetworkRefusal(ApiErrorCode.InvalidStateTransition)
  paid(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() dto: ReportP2pMarketPaidDto,
  ) {
    return this.checkout.reportPaid(id, headerValue(req, 'x-payer-token'), dto);
  }

  @Post('orders/:id/cancel')
  @Public()
  @RateLimit(P2P_CHECKOUT_ACTION_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Give up paying before you transfer (no API key)',
    description:
      'Called without an API key, with `X-Payer-Token`: the order is cancelled on-chain, the merchant’s tokens are freed and the charge can be paid again. Only before the payment is reported.',
  })
  @ORDER_ID
  @PAYER_TOKEN
  @ApiOkResponse({ type: P2pCheckoutOrderEntity, headers: NO_STORE })
  @ApiUpstream('EVM network')
  @P2pNetworkRefusal(ApiErrorCode.InvalidStateTransition)
  cancel(@Param('id') id: string, @Req() req: Request) {
    return this.checkout.cancel(id, headerValue(req, 'x-payer-token'));
  }
}
