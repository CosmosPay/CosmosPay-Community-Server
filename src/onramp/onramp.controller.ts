import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '../common/decorators/current-consumer.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { OnrampService } from './onramp.service';
import { CreatePayinQuoteDto } from './dto/create-payin-quote.dto';
import { CreatePayinDto } from './dto/create-payin.dto';
import { CreateTrustlineDto } from './dto/create-trustline.dto';
import { PayinQuoteEntity } from './entities/payin-quote.entity';
import { PayinEntity } from './entities/payin.entity';

// /v1/onramp — fiat -> stablecoin.
@ApiTags('onramp')
@Controller({ path: 'onramp', version: '1' })
export class OnrampController {
  constructor(private readonly onramp: OnrampService) {}

  @Post('quotes')
  @RequirePermissions('onramp:write')
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
  @ApiOkResponse({ type: [PayinEntity] })
  findAll(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.onramp.findAll(consumer);
  }

  @Get('payins/:id')
  @RequirePermissions('onramp:read')
  @ApiOperation({ summary: 'Get a payin (refreshes status from BlindPay)' })
  @ApiOkResponse({ type: PayinEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.onramp.findOne(consumer, id);
  }

  @Post('trustline')
  @RequirePermissions('onramp:write')
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
