import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { WidePaginationQueryDto } from '@/common/dto/pagination.query.dto';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT } from '@/native-plugins/blindpay/blindpay.constants';
import {
  ONRAMP_PAYIN_RATE_LIMIT,
  ONRAMP_QUOTE_RATE_LIMIT,
  ONRAMP_TRUSTLINE_RATE_LIMIT,
} from '@/native-plugins/blindpay/onramp/onramp.constants';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { OnrampService } from '@/native-plugins/blindpay/onramp/onramp.service';
import { CreatePayinQuoteDto } from '@/native-plugins/blindpay/onramp/dto/create-payin-quote.dto';
import { CreatePayinDto } from '@/native-plugins/blindpay/onramp/dto/create-payin.dto';
import { CreateTrustlineDto } from '@/native-plugins/blindpay/onramp/dto/create-trustline.dto';
import { PayinQuoteEntity } from '@/native-plugins/blindpay/onramp/entities/payin-quote.entity';
import {
  PayinEntity,
  PayinListEntity,
} from '@/native-plugins/blindpay/onramp/entities/payin.entity';

// /v1/onramp — fiat -> stablecoin.
@ApiTags('onramp')
@Controller({ path: 'onramp', version: '1' })
export class OnrampController {
  constructor(private readonly onramp: OnrampService) {}

  @Post('quotes')
  @ApiUpstream('BlindPay')
  @RequirePermissions('onramp:write')
  // A provider call on the instance every tenant shares, plus a stored row.
  @RateLimit(ONRAMP_QUOTE_RATE_LIMIT, BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT)
  @ApiOperation({
    summary: 'Create a payin quote (expires in ~5 min)',
    description:
      'Prices a payin through BlindPay for one of your wallets ' +
      '(`blockchain_wallet_id`, a Cosmos Pay wallet id) and records the quote ' +
      'as yours, on the BlindPay instance your key selects (a `dev` key uses ' +
      'the development instance, a `prod` key production). The quote is ' +
      "BlindPay's answer as is: create the payin from it before its " +
      '`expires_at`. Amounts are integers in minor units, and `transfers` ' +
      '(AR) and `pse` (CO) need their `payer_rules`. A wallet you do not own ' +
      "is a 404, and one whose receiver's fiat access is disabled is " +
      '`403 account_disabled`.',
  })
  @ApiCreatedResponse({ type: PayinQuoteEntity })
  createQuote(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreatePayinQuoteDto,
  ) {
    return this.onramp.createQuote(consumer, dto);
  }

  @Post('payins')
  @ApiUpstream('BlindPay')
  @RequirePermissions('onramp:write')
  // Money: the payin and its bank instructions exist at the provider whatever
  // this service answers next.
  @RateLimit(ONRAMP_PAYIN_RATE_LIMIT, BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT)
  @ApiOperation({
    summary: 'Create a payin from a quote; returns funding instructions',
    description:
      'Executes a quote from `POST /v1/onramp/quotes` at BlindPay and returns ' +
      'the payin with the instructions the payer follows to fund it ' +
      "off-platform; the destination chain is the one of the quote's wallet. " +
      'Idempotent per quote: a retry of the same quote reuses its row and its ' +
      'BlindPay `Idempotency-Key`, so it cannot create a second payin. A quote ' +
      'that is not yours, is a payout quote or was minted on the other ' +
      'instance is `404 quote_not_found`; a lapsed one is `400 quote_expired`. ' +
      'Status changes arrive later as `PAYIN_UPDATED` and `PAYIN_COMPLETED` ' +
      'webhook events.',
  })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.QuoteExpired],
  })
  @ApiCreatedResponse({ type: PayinEntity })
  createPayin(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreatePayinDto,
  ) {
    return this.onramp.createPayin(consumer, dto);
  }

  @Get('payins')
  @RequirePermissions('onramp:read')
  @ApiOperation({
    summary: "List the consumer's payins",
    description:
      "Reads this service's mirror only (no BlindPay call), newest first, " +
      "limited to your key's BlindPay instance; payins still waiting for " +
      "BlindPay's id are left out. Paginated with `take` (default 100, max " +
      '100) and `skip`; answers `{ data, total, take, skip }`, where `total` ' +
      'counts every matching payin.',
  })
  @ApiOkResponse({ type: PayinListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: WidePaginationQueryDto,
  ) {
    return this.onramp.findAll(consumer, query);
  }

  @Get('payins/:id')
  // Refreshes the mirror from BlindPay before answering.
  @ApiUpstream('BlindPay')
  @RequirePermissions('onramp:read')
  @ApiOperation({
    summary:
      'Get a payin (serves the local mirror; refreshes from BlindPay when stale)',
    description:
      'Answers from the mirror while it was updated in the last 60 seconds; ' +
      'an older row is refreshed from BlindPay first, and when BlindPay cannot ' +
      'answer the stored row is returned instead of an error. Only payins of ' +
      "your key's BlindPay instance that BlindPay already acknowledged; " +
      'anything else is 404.',
  })
  @ApiOkResponse({ type: PayinEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.onramp.findOne(consumer, id);
  }

  @Post('trustline')
  @ApiUpstream('BlindPay')
  @RequirePermissions('onramp:write')
  // Reads the account from Horizon, against the per-IP budget every route here
  // shares.
  @RateLimit(ONRAMP_TRUSTLINE_RATE_LIMIT)
  @ApiOperation({
    summary:
      'Build an unsigned Stellar trustline tx (XDR) for the customer to sign',
    description:
      'Asks BlindPay to build the unsigned Stellar transaction that adds the ' +
      "trustline `address` needs to hold the onramp's stablecoin, and returns " +
      "BlindPay's answer as is. The customer signs it: this service never " +
      "signs. Built on your key's BlindPay instance; nothing is stored.",
  })
  createTrustline(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateTrustlineDto,
  ) {
    return this.onramp.createTrustline(consumer, dto);
  }
}
