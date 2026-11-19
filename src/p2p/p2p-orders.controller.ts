import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import {
  CreateP2pMarketOrderDto,
  CreateP2pMarketQuoteDto,
  QueryP2pMarketOrdersDto,
  ReportP2pMarketPaidDto,
} from '@/p2p/dto/p2p-order.dto';
import { P2pMarketTransferMatchesDto } from '@/p2p/dto/p2p-transaction.dto';
import { P2pMarketQuoteEntity } from '@/p2p/entities/p2p-offer.entity';
import {
  P2pMarketCreatedOrderEntity,
  P2pMarketMerchantOrderEntity,
  P2pMarketMerchantOrderListEntity,
  P2pMarketOrderEntity,
  P2pMarketOrderListEntity,
  P2pMarketTransferMatchListEntity,
} from '@/p2p/entities/p2p-order.entity';
import {
  P2pNetworkRefusal,
  P2pNoMatchResponse,
  P2pOrderIdParam,
} from '@/p2p/p2p-api-docs';
import { P2pOrdersService } from '@/p2p/p2p-orders.service';
import { P2pQuotesService } from '@/p2p/p2p-quotes.service';
import { P2pTransferMatchesService } from '@/p2p/p2p-transfer-matches.service';
import {
  P2P_ORDER_ACTION_RATE_LIMIT,
  P2P_ORDER_CREATE_RATE_LIMIT,
  P2P_QUOTE_RATE_LIMIT,
} from '@/p2p/p2p.constants';

/**
 * `/v1/p2p/quotes`, `/v1/p2p/orders` and `/v1/p2p/merchant/*`: the trade
 * itself, as the client that creates it and as the merchant that fills it.
 */
@ApiTags('p2p-market')
@Controller({ path: 'p2p', version: '1' })
export class P2pOrdersController {
  constructor(
    private readonly quotes: P2pQuotesService,
    private readonly orders: P2pOrdersService,
    private readonly matches: P2pTransferMatchesService,
  ) {}

  @Post('quotes')
  @RequirePermissions('p2p:write')
  @RateLimit(P2P_QUOTE_RATE_LIMIT)
  @ApiOperation({
    summary:
      'Quote a purchase or a sale: the merchant, the price and the fees, for a minute',
    description:
      'The person types an amount; the market picks the merchant: the best price among those that can fill it right now (a fresh price, the amount within their limits, the rail, room for another order, and on-chain liquidity: for a purchase the merchant’s balance and its matcher cap, for a sale its bond), then reputation. The answer names the merchant by its display name and track record only. Create the order with `POST /v1/p2p/orders` before `expiresAt`.',
  })
  @ApiCreatedResponse({ type: P2pMarketQuoteEntity })
  @ApiUpstream('EVM network')
  @P2pNetworkRefusal(ApiErrorCode.AssetUnsupported)
  @P2pNoMatchResponse()
  quote(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateP2pMarketQuoteDto,
  ) {
    return this.quotes.create(consumer, dto);
  }

  @Post('orders')
  @RequirePermissions('p2p:write')
  @RateLimit(P2P_ORDER_CREATE_RATE_LIMIT)
  @ApiOperation({
    summary: 'Create an order from a quote',
    description:
      'A purchase (BUY) is opened by the matcher on the merchant’s balance, delivering to `recipient`; the answer carries the merchant’s payment details and `paymentDeadline` once the chain shows it open (`P2P_ORDER_CREATED`). A sale (SELL) answers `transactions`: the exact approval and `openWithDeposit`, for the `seller` wallet to sign; the merchant accepts it with a bond and pays `beneficiary`. One order per quote: the same quote and wallet again answer the same order.',
  })
  @ApiCreatedResponse({ type: P2pMarketCreatedOrderEntity })
  @ApiUpstream('EVM network')
  @P2pNetworkRefusal(ApiErrorCode.QuoteExpired)
  @P2pNoMatchResponse(ApiErrorCode.IdempotencyConflict)
  @ApiErrorResponse({ status: 404, codes: [ApiErrorCode.QuoteNotFound] })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateP2pMarketOrderDto,
  ) {
    return this.orders.create(consumer, dto);
  }

  @Get('orders')
  @RequirePermissions('p2p:read')
  @ApiOperation({
    summary: 'List the orders you created',
    description:
      'Purchases, sales, charges’ orders and payouts, newest first, on the key’s tier, optionally by `status` and `kind`; paginated with `take` and `skip`. Payment details are left out of lists: read one order for them.',
  })
  @ApiOkResponse({ type: P2pMarketOrderListEntity })
  @P2pNetworkRefusal()
  list(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryP2pMarketOrdersDto,
  ) {
    return this.orders.list(consumer, query);
  }

  @Get('orders/:id')
  @RequirePermissions('p2p:read')
  @ApiOperation({
    summary: 'Get one of your orders',
    description:
      'Its status as the chain last showed it, its deadlines and transactions, and, on a live purchase or charge, the merchant’s account to pay (`paymentDetails`).',
  })
  @P2pOrderIdParam()
  @ApiOkResponse({ type: P2pMarketOrderEntity })
  @P2pNetworkRefusal()
  get(@CurrentConsumer() consumer: GatewayConsumer, @Param('id') id: string) {
    return this.orders.get(consumer, id);
  }

  @Post('orders/:id/paid')
  @RequirePermissions('p2p:write')
  @RateLimit(P2P_ORDER_ACTION_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Report that the person sent the local money (purchases and charges)',
    description:
      'The matcher marks the order paid on-chain for the buyer, with the transfer `reference` kept for the merchant; from then on the merchant can no longer take the tokens back alone. Only for a purchase or a charge awaiting payment, before its deadline.',
  })
  @P2pOrderIdParam()
  @ApiOkResponse({ type: P2pMarketOrderEntity })
  @ApiUpstream('EVM network')
  @P2pNetworkRefusal(ApiErrorCode.InvalidStateTransition)
  paid(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: ReportP2pMarketPaidDto,
  ) {
    return this.orders.act(consumer, id, 'paid', dto);
  }

  @Post('orders/:id/cancel')
  @RequirePermissions('p2p:write')
  @RateLimit(P2P_ORDER_ACTION_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Give up a purchase before paying, or withdraw a payout nobody accepted',
    description:
      'The matcher cancels the order for the buyer and its tokens go back to the seller. A purchase or a charge awaiting payment, or a payout awaiting acceptance; a sale is cancelled by the seller’s own wallet (`POST /v1/p2p/transactions`).',
  })
  @P2pOrderIdParam()
  @ApiOkResponse({ type: P2pMarketOrderEntity })
  @ApiUpstream('EVM network')
  @P2pNetworkRefusal(ApiErrorCode.InvalidStateTransition)
  cancel(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.orders.act(consumer, id, 'cancel');
  }

  @Post('orders/:id/dispute')
  @RequirePermissions('p2p:write')
  @RateLimit(P2P_ORDER_ACTION_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Escalate a paid purchase the merchant does not release',
    description:
      'The matcher disputes the order for the buyer and the arbiter decides how it is split, paying only the order’s own buyer and seller. A paid purchase or charge; a sale’s or a payout’s dispute is signed by its own wallet (`POST /v1/p2p/transactions`).',
  })
  @P2pOrderIdParam()
  @ApiOkResponse({ type: P2pMarketOrderEntity })
  @ApiUpstream('EVM network')
  @P2pNetworkRefusal(ApiErrorCode.InvalidStateTransition)
  dispute(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.orders.act(consumer, id, 'dispute');
  }

  @Get('merchant/orders')
  @RequirePermissions('p2p:read')
  @ApiOperation({
    summary: 'List the orders your merchant accounts fill',
    description:
      'Newest first, on the key’s tier, optionally by `status` and `kind`; paginated with `take` and `skip`. A live order carries what you need to settle it: the payer’s name and document on a purchase or a charge, the beneficiary’s account on a sale or a payout.',
  })
  @ApiOkResponse({ type: P2pMarketMerchantOrderListEntity })
  @P2pNetworkRefusal()
  merchantList(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryP2pMarketOrdersDto,
  ) {
    return this.orders.merchantList(consumer, query);
  }

  @Get('merchant/orders/:id')
  @RequirePermissions('p2p:read')
  @ApiOperation({
    summary: 'Get one order your merchant account fills',
    description:
      'As in the list. Nothing about the client that created it; the other party’s details only while it is live.',
  })
  @P2pOrderIdParam()
  @ApiOkResponse({ type: P2pMarketMerchantOrderEntity })
  @P2pNetworkRefusal()
  merchantGet(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.orders.merchantGet(consumer, id);
  }

  @Post('merchant/transfer-matches')
  @RequirePermissions('p2p:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Find the orders an incoming bank transfer settles, with their release ready',
    description:
      'For a merchant’s bot: forward each bank notification. The answer lists your live purchases and charges for that exact amount and currency (created before `receivedAt`), best first: a reported payment, a matching payer name and document score higher. Each carries its `release` transaction for your wallet or bot to sign; nothing moves until it does.',
  })
  @ApiOkResponse({ type: P2pMarketTransferMatchListEntity })
  @P2pNetworkRefusal()
  transferMatches(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: P2pMarketTransferMatchesDto,
  ) {
    return this.matches.match(consumer, dto);
  }
}
