import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
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
import { BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT } from '@/blindpay/blindpay.constants';
import {
  ONRAMP_PAYIN_RATE_LIMIT,
  ONRAMP_QUOTE_RATE_LIMIT,
  ONRAMP_TRUSTLINE_RATE_LIMIT,
} from '@/onramp/onramp.constants';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { OnrampService } from '@/onramp/onramp.service';
import { CreatePayinQuoteDto } from '@/onramp/dto/create-payin-quote.dto';
import { CreatePayinDto } from '@/onramp/dto/create-payin.dto';
import { CreateTrustlineDto } from '@/onramp/dto/create-trustline.dto';
import { PayinQuoteEntity } from '@/onramp/entities/payin-quote.entity';
import { PayinEntity, PayinListEntity } from '@/onramp/entities/payin.entity';

// /v1/onramp — fiat -> stablecoin.
@ApiTags('onramp')
@Controller({ path: 'onramp', version: '1' })
export class OnrampController {
  constructor(private readonly onramp: OnrampService) {}

  @Post('quotes')
  @RequirePermissions('onramp:write')
  // A provider call on the instance every tenant shares, plus a stored row.
  @RateLimit(ONRAMP_QUOTE_RATE_LIMIT, BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT)
  @ApiOperation({ summary: 'Create a payin quote (expires in ~5 min)' })
  @ApiCreatedResponse({ type: PayinQuoteEntity })
  createQuote(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreatePayinQuoteDto,
  ) {
    return this.onramp.createQuote(consumer, dto);
  }

  @Post('payins')
  @RequirePermissions('onramp:write')
  // Money: the payin and its bank instructions exist at the provider whatever
  // this service answers next.
  @RateLimit(ONRAMP_PAYIN_RATE_LIMIT, BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT)
  @ApiOperation({
    summary: 'Create a payin from a quote; returns funding instructions',
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
  @ApiOperation({ summary: "List the consumer's payins" })
  @ApiOkResponse({ type: PayinListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: WidePaginationQueryDto,
  ) {
    return this.onramp.findAll(consumer, query);
  }

  @Get('payins/:id')
  @RequirePermissions('onramp:read')
  @ApiOperation({
    summary:
      'Get a payin (serves the local mirror; refreshes from BlindPay when stale)',
  })
  @ApiOkResponse({ type: PayinEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.onramp.findOne(consumer, id);
  }

  @Post('trustline')
  @RequirePermissions('onramp:write')
  // Reads the account from Horizon, against the per-IP budget every route here
  // shares.
  @RateLimit(ONRAMP_TRUSTLINE_RATE_LIMIT)
  @ApiOperation({
    summary:
      'Build an unsigned Stellar trustline tx (XDR) for the customer to sign',
  })
  createTrustline(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateTrustlineDto,
  ) {
    return this.onramp.createTrustline(consumer, dto);
  }
}
