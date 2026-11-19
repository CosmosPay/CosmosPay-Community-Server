import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
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
  CreateP2pMarketChargeDto,
  CreateP2pMarketPayoutDto,
  QueryP2pMarketChargesDto,
  QueryP2pMarketPayoutsDto,
} from '@/p2p/dto/p2p-charge.dto';
import {
  P2pMarketChargeEntity,
  P2pMarketChargeListEntity,
  P2pMarketPayoutBatchEntity,
  P2pMarketPayoutBatchListEntity,
} from '@/p2p/entities/p2p-charge.entity';
import {
  P2pChargeIdParam,
  P2pNetworkRefusal,
  P2pNoMatchResponse,
} from '@/p2p/p2p-api-docs';
import { P2pChargesService } from '@/p2p/p2p-charges.service';
import { P2pPayoutsService } from '@/p2p/p2p-payouts.service';
import { P2P_PAYOUT_RATE_LIMIT } from '@/p2p/p2p.constants';

/** `/v1/p2p/charges` and `/v1/p2p/payouts`: collections and payouts in local money. */
@ApiTags('p2p-market')
@Controller({ path: 'p2p', version: '1' })
export class P2pChargesController {
  constructor(
    private readonly charges: P2pChargesService,
    private readonly payouts: P2pPayoutsService,
  ) {}

  @Post('charges')
  @RequirePermissions('p2p:write')
  @ApiOperation({
    summary: 'Charge an amount of local money, paid on a hosted page',
    description:
      'Answers `url`, the payer’s page (`PAYMENT_LINK_CHECKOUT_URL/p2p/<id>`). The payer picks a rail and gives their name, document and email; a merchant is matched and the payer transfers to it; when the merchant releases, the tokens go to `recipient` (one of your registered accounts) and `P2P_CHARGE_SUCCEEDED` is sent. One payer at a time unless `multiUse`.',
  })
  @ApiCreatedResponse({ type: P2pMarketChargeEntity })
  @ApiUpstream('EVM network')
  @P2pNetworkRefusal(ApiErrorCode.AssetUnsupported)
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateP2pMarketChargeDto,
  ) {
    return this.charges.create(consumer, dto);
  }

  @Get('charges')
  @RequirePermissions('p2p:read')
  @ApiOperation({
    summary: 'List your charges',
    description:
      'Newest first, on the key’s tier; paginated with `take` and `skip`. An open charge past `expiresAt` reads `expired`. Its orders are in `GET /v1/p2p/orders?kind=CHARGE`.',
  })
  @ApiOkResponse({ type: P2pMarketChargeListEntity })
  @P2pNetworkRefusal()
  list(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryP2pMarketChargesDto,
  ) {
    return this.charges.list(consumer, query);
  }

  @Get('charges/:id')
  @RequirePermissions('p2p:read')
  @ApiOperation({
    summary: 'Get one of your charges',
    description: 'How it stands, how many orders paid it, and its payer page.',
  })
  @P2pChargeIdParam()
  @ApiOkResponse({ type: P2pMarketChargeEntity })
  @P2pNetworkRefusal()
  get(@CurrentConsumer() consumer: GatewayConsumer, @Param('id') id: string) {
    return this.charges.get(consumer, id);
  }

  @Delete('charges/:id')
  @RequirePermissions('p2p:write')
  @ApiOperation({
    summary: 'Cancel an open charge',
    description:
      'No new payer can start; an order already under way goes on (its payer may have paid) and still pays the recipient when it completes.',
  })
  @P2pChargeIdParam()
  @ApiOkResponse({ type: P2pMarketChargeEntity })
  @P2pNetworkRefusal()
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.RequestClosed],
    examples: {
      [ApiErrorCode.RequestClosed]: {
        summary: 'The charge is no longer open',
        message:
          'P2P charge 9b7e2c41-3f5a-4d8e-a1b2-c3d4e5f60718 is paid: it can no longer be cancelled',
        path: '/v1/p2p/charges/9b7e2c41-3f5a-4d8e-a1b2-c3d4e5f60718',
      },
    },
  })
  cancel(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.charges.cancel(consumer, id);
  }

  @Post('payouts')
  @RequirePermissions('p2p:write')
  @RateLimit(P2P_PAYOUT_RATE_LIMIT)
  @ApiOperation({
    summary: 'Pay out local money from your balance in the contract',
    description:
      'Up to 100 items. Each is matched with a merchant that buys tokens and opened by the matcher on your account’s balance (authorise it first with `setMatcher`); the merchant accepts with a 10% bond, pays the beneficiary and marks it paid; you release it (`POST /v1/p2p/transactions`), or silence does after six hours if you allowed `autoSettle`. Items no merchant can take now are listed in `failedItems`; `P2P_PAYOUT_BATCH_COMPLETED` is sent when every order ended.',
  })
  @ApiCreatedResponse({ type: P2pMarketPayoutBatchEntity })
  @ApiUpstream('EVM network')
  @P2pNetworkRefusal(
    ApiErrorCode.AssetUnsupported,
    ApiErrorCode.InvalidStateTransition,
  )
  @P2pNoMatchResponse()
  createPayout(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateP2pMarketPayoutDto,
  ) {
    return this.payouts.create(consumer, dto);
  }

  @Get('payouts')
  @RequirePermissions('p2p:read')
  @ApiOperation({
    summary: 'List your payout batches',
    description:
      'Newest first, on the key’s tier, without their orders; paginated with `take` and `skip`.',
  })
  @ApiOkResponse({ type: P2pMarketPayoutBatchListEntity })
  @P2pNetworkRefusal()
  listPayouts(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryP2pMarketPayoutsDto,
  ) {
    return this.payouts.list(consumer, query);
  }

  @Get('payouts/:id')
  @RequirePermissions('p2p:read')
  @ApiOperation({
    summary: 'Get a payout batch with its orders',
    description:
      'Each item’s order as it stands on-chain, and the items that never opened.',
  })
  @ApiParam({
    name: 'id',
    description: 'The batch id.',
    example: 'cm3p2ppob0001l70g8v5q3z2w',
  })
  @ApiOkResponse({ type: P2pMarketPayoutBatchEntity })
  @P2pNetworkRefusal()
  getPayout(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.payouts.get(consumer, id);
  }
}
