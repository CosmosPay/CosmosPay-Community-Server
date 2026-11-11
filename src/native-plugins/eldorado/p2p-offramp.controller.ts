import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { ApiRecordTokenHeader } from '@/common/decorators/api-record-token.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { WidePaginationQueryDto } from '@/common/dto/pagination.query.dto';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { RECORD_TOKEN_HEADER } from '@/common/public-record-token.constants';
import { headerValue } from '@/common/request-header';
import {
  P2pOrderDto,
  P2pSessionParamsDto,
  P2pTokensQueryDto,
} from '@/native-plugins/eldorado/dto/p2p-ramp.dto';
import {
  P2P_SELL_QUOTE_RATE_LIMIT,
  P2P_SELL_SESSION_RATE_LIMIT,
} from '@/native-plugins/eldorado/eldorado.constants';
import {
  P2pMarketEntity,
  P2pQuoteEntity,
  P2pSessionCreatedEntity,
  P2pSessionEntity,
  P2pSessionListEntity,
  P2pTokenListEntity,
} from '@/native-plugins/eldorado/entities/p2p-ramp.entity';
import { P2pRampService } from '@/native-plugins/eldorado/p2p-ramp.service';

// /v1/offramp/p2p: tokens on any chain the market lists, sold for local money to P2P buyers.
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
    summary: 'Read what tokens can be sold for local money',
    description:
      "The currencies a seller can be paid in on the key's network (a `prod` key reads mainnet, a `dev` key the sandbox), " +
      'each with its payment methods, sell price (local money per USD stablecoin) and minimum (in USD), plus the chains a ' +
      'sale can send from (each with its token count) and the token a form starts from. Read from the P2P marketplace and ' +
      'served from memory for up to a minute; a currency without a price, a minimum or a payment method is left out, and ' +
      'so is a chain whose token list cannot be read right now.',
  })
  @ApiOkResponse({ type: P2pMarketEntity })
  market(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.p2p.market(consumer, 'sell');
  }

  @Get('tokens')
  // Each chain's list is read from the marketplace at most once an hour.
  @ApiUpstream('P2P marketplace')
  @RequirePermissions('offramp:read')
  // Market data, the same for every caller, like the market itself.
  @AllowPublicKey()
  @ApiOperation({
    summary: 'List the tokens a sale can send on one chain',
    description:
      'One chain of the market (`chainId`, one of its `networks`), a page at a time: each token with its contract address, ' +
      'symbol, decimals and USD price. The network’s main assets come first, matched by address (its own coin, its USD ' +
      'stablecoins, the wrapped coin, bitcoin, its token, other stablecoins, DeFi blue chips, liquid staked ether), then ' +
      'every other token in the marketplace’s order. `q` searches by symbol fragment or exact address. ' +
      'A chain the market does not offer right now is `400 validation_failed`.',
  })
  @ApiOkResponse({ type: P2pTokenListEntity })
  tokens(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: P2pTokensQueryDto,
  ) {
    return this.p2p.tokens(consumer, query);
  }

  @Post('quotes')
  @ApiUpstream('P2P marketplace')
  @RequirePermissions('offramp:write')
  // Stores nothing: a wallet with no account prices its order too (budgeted
  // per address, like every caller of the shared key).
  @AllowPublicKey()
  @RateLimit(P2P_SELL_QUOTE_RATE_LIMIT)
  @ApiOperation({
    summary: 'Get a firm price for a sale for local money',
    description:
      'The P2P marketplace prices the sale of `amount` of the token sent from `address` on `chainId`: the local money paid with ' +
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
  // A wallet with no account opens its own sale; the row is read back only
  // with its record token, and the list stays closed to the shared key.
  @AllowPublicKey()
  @RateLimit(P2P_SELL_SESSION_RATE_LIMIT)
  @ApiOperation({
    summary: 'Open a sale for local money',
    description:
      'Records the order and answers `widgetUrl`, the hosted sale that takes it: open it in a browser tab or window, ' +
      'where the seller signs in, verifies their identity, connects the wallet holding the token and sends it, and a ' +
      'P2P buyer pays the local money with the chosen method. `address` is recorded as the account it is sent from; the ' +
      'widget does not fix it. `estimatedAmountOut` is the local money at the market price, rounded down (null for a token with no USD price); the widget ' +
      "quotes the firm figure first. The order is checked against the market (`400 validation_failed` with the reason), and opened on the key's network. " +
      'The shared public key also gets `publicToken`, the only way it reads the session back.',
  })
  @ApiCreatedResponse({ type: P2pSessionCreatedEntity })
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
  @AllowPublicKey()
  @ApiRecordTokenHeader()
  @ApiOperation({
    summary: 'Read a sale opened for local money',
    description:
      "One sale of this key's consumer on the key's network, from this service's records, with its widget URL. " +
      "Another consumer's session, one opened on the other network, or a purchase, is the 404 of a missing one. The shared " +
      "public key reads a session only with its `publicToken` in `X-Record-Token`; without it, or with another session's, " +
      'the answer is that 404. Listing sessions stays closed to the public key.',
  })
  @ApiOkResponse({ type: P2pSessionEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param() params: P2pSessionParamsDto,
    @Req() req: Request,
  ) {
    return this.p2p.findOne(
      consumer,
      'sell',
      params.id,
      headerValue(req, RECORD_TOKEN_HEADER),
    );
  }
}
