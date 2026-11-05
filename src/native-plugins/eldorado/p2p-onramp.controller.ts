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
} from '@/native-plugins/eldorado/dto/p2p-onramp.dto';
import {
  P2P_QUOTE_RATE_LIMIT,
  P2P_SESSION_RATE_LIMIT,
} from '@/native-plugins/eldorado/eldorado.constants';
import {
  P2pMarketEntity,
  P2pQuoteEntity,
  P2pSessionEntity,
  P2pSessionListEntity,
} from '@/native-plugins/eldorado/entities/p2p-onramp.entity';
import { P2pOnrampService } from '@/native-plugins/eldorado/p2p-onramp.service';

// /v1/onramp/p2p: stablecoins bought with local money from P2P sellers.
@ApiTags('p2p-onramp')
@Controller({ path: 'onramp/p2p', version: '1' })
export class P2pOnrampController {
  constructor(private readonly p2p: P2pOnrampService) {}

  @Get('market')
  // Read from the marketplace when the cached copy is over a minute old.
  @ApiUpstream('P2P marketplace')
  @RequirePermissions('onramp:read')
  // Market data, the same for every caller: no per-consumer rows, so the
  // wallets without an account may read it too.
  @AllowPublicKey()
  @ApiOperation({
    summary: 'Read what can be bought with local money',
    description:
      "The currencies a buyer can pay with on the key's network (a `prod` key reads mainnet, a `dev` key the sandbox), " +
      'each with its payment methods, buy price and minimum, plus the chain and the stablecoins a purchase delivers. ' +
      'Read from the P2P marketplace and served from memory for up to a minute; a currency without a price, a minimum ' +
      'or a payment method is left out.',
  })
  @ApiOkResponse({ type: P2pMarketEntity })
  market(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.p2p.market(consumer);
  }

  @Post('quotes')
  @ApiUpstream('P2P marketplace')
  @RequirePermissions('onramp:write')
  @RateLimit(P2P_QUOTE_RATE_LIMIT)
  @ApiOperation({
    summary: 'Get a firm price for a purchase with local money',
    description:
      'The P2P marketplace prices the order: the stablecoin delivered with fees taken, the least it can deliver, the ' +
      'rate and the fees, valid until `expiresAt`. Nothing is stored. The order is checked against the market first ' +
      '(currency, payment method, token and minimum: `400 validation_failed` with the reason). A deployment without ' +
      'the marketplace integrator ids answers `503 misconfigured`; the market and the sessions work without them.',
  })
  @ApiCreatedResponse({ type: P2pQuoteEntity })
  quote(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: P2pOrderDto,
  ) {
    return this.p2p.quote(consumer, dto);
  }

  @Post('sessions')
  // Checks the order against the market, which may be read first.
  @ApiUpstream('P2P marketplace')
  @RequirePermissions('onramp:write')
  @RateLimit(P2P_SESSION_RATE_LIMIT)
  @ApiOperation({
    summary: 'Open a purchase with local money',
    description:
      'Records the order and answers `widgetUrl`, the hosted purchase that takes it: open it in a browser tab or ' +
      'window, where the buyer signs in, verifies their identity and pays a P2P seller. `address` is fixed as the ' +
      'recipient there, so the stablecoin can only be delivered to it. `estimatedAmountOut` is the market price, ' +
      'rounded down; the widget quotes the firm figure before payment. The order is checked against the market first ' +
      "(`400 validation_failed` with the reason), and opened on the key's network.",
  })
  @ApiCreatedResponse({ type: P2pSessionEntity })
  createSession(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: P2pOrderDto,
  ) {
    return this.p2p.createSession(consumer, dto);
  }

  @Get('sessions')
  @RequirePermissions('onramp:read')
  @ApiOperation({
    summary: 'List the purchases opened with local money',
    description:
      "The sessions this key's consumer opened on the key's network, newest first, from this service's records (no " +
      'call to the marketplace). Paginated with `take` (default 100, max 100) and `skip`; answers ' +
      '`{ data, total, take, skip }`, where `total` counts every matching session.',
  })
  @ApiOkResponse({ type: P2pSessionListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: WidePaginationQueryDto,
  ) {
    return this.p2p.findAll(consumer, query);
  }

  @Get('sessions/:id')
  @RequirePermissions('onramp:read')
  @ApiOperation({
    summary: 'Read a purchase opened with local money',
    description:
      "One session of this key's consumer on the key's network, from this service's records, with its widget URL. " +
      "Another consumer's session, or one opened on the other network, is the 404 of a missing one.",
  })
  @ApiOkResponse({ type: P2pSessionEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param() params: P2pSessionParamsDto,
  ) {
    return this.p2p.findOne(consumer, params.id);
  }
}
