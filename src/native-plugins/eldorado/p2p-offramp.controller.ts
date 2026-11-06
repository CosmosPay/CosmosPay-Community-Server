import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { WidePaginationQueryDto } from '@/common/dto/pagination.query.dto';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import {
  P2pOrderDto,
  P2pSessionParamsDto,
} from '@/native-plugins/eldorado/dto/p2p-ramp.dto';
import {
  P2P_SELL_QUOTE_RATE_LIMIT,
  P2P_SELL_SESSION_RATE_LIMIT,
} from '@/native-plugins/eldorado/eldorado.constants';
import {
  P2pMarketEntity,
  P2pQuoteEntity,
  P2pSessionEntity,
  P2pSessionListEntity,
} from '@/native-plugins/eldorado/entities/p2p-ramp.entity';
import { P2pRampService } from '@/native-plugins/eldorado/p2p-ramp.service';

// /v1/offramp/p2p: stablecoins sold for local money to P2P buyers.
@ApiTags('p2p-offramp')
@Controller({ path: 'offramp/p2p', version: '1' })
export class P2pOfframpController {
  constructor(private readonly p2p: P2pRampService) {}

  @Get('market')
  // Read from the marketplace when the cached copy is over a minute old.
  @ApiUpstream('P2P marketplace')
  @RequirePermissions('offramp:read')
  // Market data, the same for every caller: no per-consumer rows, so the
  // wallets without an account may read it too.
  @AllowPublicKey()
  @ApiOperation({
    summary: 'Read what stablecoins can be sold for in local money',
    description:
      "The currencies a seller can be paid in on the key's network (a `prod` key reads mainnet, a `dev` key the sandbox), " +
      'each with its payment methods, sell price (local money per stablecoin) and minimum (in the stablecoin), plus the ' +
      'chain and the stablecoins a sale takes. Read from the P2P marketplace and served from memory for up to a minute; ' +
      'a currency without a price, a minimum or a payment method is left out.',
  })
  @ApiOkResponse({ type: P2pMarketEntity })
  market(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.p2p.market(consumer, 'sell');
  }

  @Post('quotes')
  @ApiUpstream('P2P marketplace')
  @RequirePermissions('offramp:write')
  @RateLimit(P2P_SELL_QUOTE_RATE_LIMIT)
  @ApiOperation({
    summary: 'Get a firm price for a sale for local money',
    description:
      'The P2P marketplace prices the sale of `amount` of the stablecoin sent from `address`: the local money paid with ' +
      'fees taken, the least it can pay, the rate and the fees, valid until `expiresAt`. Nothing is stored. The order is ' +
      'checked against the market first (currency, payment method, token and minimum: `400 validation_failed` with the ' +
      'reason). A deployment without the marketplace integrator ids answers `503 misconfigured`; the market and the ' +
      'sessions work without them.',
  })
  @ApiCreatedResponse({ type: P2pQuoteEntity })
  quote(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: P2pOrderDto,
  ) {
    return this.p2p.quote(consumer, 'sell', dto);
  }

  @Post('sessions')
  // Checks the order against the market, which may be read first.
  @ApiUpstream('P2P marketplace')
  @RequirePermissions('offramp:write')
  @RateLimit(P2P_SELL_SESSION_RATE_LIMIT)
  @ApiOperation({
    summary: 'Open a sale for local money',
    description:
      'Records the order and answers `widgetUrl`, the hosted sale that takes it: open it in a browser tab or window, ' +
      'where the seller signs in, verifies their identity, connects the wallet holding the stablecoin and sends it, and a ' +
      'P2P buyer pays the local money with the chosen method. `address` is recorded as the account it is sent from; the ' +
      'widget does not fix it. `estimatedAmountOut` is the local money at the market price, rounded down; the widget ' +
      "quotes the firm figure first. The order is checked against the market (`400 validation_failed` with the reason), and opened on the key's network.",
  })
  @ApiCreatedResponse({ type: P2pSessionEntity })
  createSession(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: P2pOrderDto,
  ) {
    return this.p2p.createSession(consumer, 'sell', dto);
  }

  @Get('sessions')
  @RequirePermissions('offramp:read')
  @ApiOperation({
    summary: 'List the sales opened for local money',
    description:
      "The sales this key's consumer opened on the key's network, newest first, from this service's records (no " +
      'call to the marketplace). Paginated with `take` (default 100, max 100) and `skip`; answers ' +
      '`{ data, total, take, skip }`, where `total` counts every matching session.',
  })
  @ApiOkResponse({ type: P2pSessionListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: WidePaginationQueryDto,
  ) {
    return this.p2p.findAll(consumer, 'sell', query);
  }

  @Get('sessions/:id')
  @RequirePermissions('offramp:read')
  @ApiOperation({
    summary: 'Read a sale opened for local money',
    description:
      "One sale of this key's consumer on the key's network, from this service's records, with its widget URL. " +
      "Another consumer's session, one opened on the other network, or a purchase, is the 404 of a missing one.",
  })
  @ApiOkResponse({ type: P2pSessionEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param() params: P2pSessionParamsDto,
  ) {
    return this.p2p.findOne(consumer, 'sell', params.id);
  }
}
