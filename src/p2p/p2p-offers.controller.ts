import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import {
  CreateP2pMarketOfferDto,
  QueryP2pMarketOffersDto,
  UpdateP2pMarketOfferDto,
} from '@/p2p/dto/p2p-offer.dto';
import {
  P2pMarketOfferEntity,
  P2pMarketOfferListEntity,
} from '@/p2p/entities/p2p-offer.entity';
import { P2pNetworkRefusal, P2pRowIdParam } from '@/p2p/p2p-api-docs';
import { P2pOffersService } from '@/p2p/p2p-offers.service';

const OFFER_ID = P2pRowIdParam('offer', 'cm3p2poff0001l70g8v5q3z2w');

/** `/v1/p2p/offers`: merchants' standing prices, refreshed by their bots. */
@ApiTags('p2p-market')
@Controller({ path: 'p2p', version: '1' })
export class P2pOffersController {
  constructor(private readonly offers: P2pOffersService) {}

  @Post('offers')
  @RequirePermissions('p2p:write')
  @ApiOperation({
    summary: 'Publish a standing price as a merchant',
    description:
      'A price in local money per token on one network, token and currency, on the rails you take, with order limits. SELL_TOKEN offers fill purchases from your balance in the contract through the matcher (authorise it with `setMatcher`, and keep an active payment method on each rail); BUY_TOKEN offers fill sales and payouts, accepted by you with a 10% bond. A price older than `priceTtlSeconds` is not matched: refresh it with a PATCH.',
  })
  @ApiCreatedResponse({ type: P2pMarketOfferEntity })
  @P2pNetworkRefusal(ApiErrorCode.AssetUnsupported)
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateP2pMarketOfferDto,
  ) {
    return this.offers.create(consumer, dto);
  }

  @Get('offers')
  @RequirePermissions('p2p:read')
  @ApiOperation({
    summary: 'List your offers',
    description:
      'Newest first, on the key’s tier, optionally for one `accountId`; paginated with `take` and `skip`. `priceFresh` says whether each can be matched now.',
  })
  @ApiOkResponse({ type: P2pMarketOfferListEntity })
  @P2pNetworkRefusal()
  list(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryP2pMarketOffersDto,
  ) {
    return this.offers.list(consumer, query);
  }

  @Patch('offers/:id')
  @RequirePermissions('p2p:write')
  @ApiOperation({
    summary: 'Refresh a price, change limits or rails, or switch an offer off',
    description:
      'A new `price` restarts its lifetime: this is the call a merchant’s bot makes on every price tick. Orders already open keep the price they were matched at.',
  })
  @OFFER_ID
  @ApiOkResponse({ type: P2pMarketOfferEntity })
  @P2pNetworkRefusal()
  update(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: UpdateP2pMarketOfferDto,
  ) {
    return this.offers.update(consumer, id, dto);
  }

  @Delete('offers/:id')
  @RequirePermissions('p2p:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an offer',
    description: 'Orders already matched to it go on; nothing new matches it.',
  })
  @OFFER_ID
  @ApiNoContentResponse({ description: 'Deleted.' })
  @P2pNetworkRefusal()
  async remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    await this.offers.remove(consumer, id);
  }
}
