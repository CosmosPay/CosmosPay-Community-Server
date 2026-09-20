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
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { CreatePrivateRfqDto } from '@/private-rfqs/dto/create-private-rfq.dto';
import { CreateRfqPaymentIntentDto } from '@/private-rfqs/dto/create-rfq-payment-intent.dto';
import { QueryPrivateRfqsDto } from '@/private-rfqs/dto/query-private-rfqs.dto';
import { SelectPrivateQuoteDto } from '@/private-rfqs/dto/select-private-quote.dto';
import {
  PrivateRfqEntity,
  PrivateRfqListEntity,
  PrivateRfqPaymentEntity,
} from '@/private-rfqs/entities/private-rfq.entity';
import { PrivateRfqsService } from '@/private-rfqs/private-rfqs.service';

@ApiTags('private-rfqs')
@Controller({ path: 'private-rfqs', version: '1' })
export class PrivateRfqsController {
  constructor(private readonly privateRfqs: PrivateRfqsService) {}

  @Post()
  @RequirePermissions('private-rfqs:write')
  @ApiOperation({
    summary: 'Register and verify a wallet-created Sub Rosa round',
  })
  @ApiCreatedResponse({ type: PrivateRfqEntity })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreatePrivateRfqDto,
  ) {
    return this.privateRfqs.create(consumer, dto);
  }

  @Get()
  @RequirePermissions('private-rfqs:read')
  @ApiOperation({ summary: "List the consumer's private RFQs" })
  @ApiOkResponse({ type: PrivateRfqListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryPrivateRfqsDto,
  ) {
    return this.privateRfqs.findAll(consumer, query);
  }

  @Get(':id')
  @RequirePermissions('private-rfqs:read')
  @ApiOperation({ summary: 'Get an RFQ with live Sub Rosa reveal state' })
  @ApiOkResponse({ type: PrivateRfqEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.privateRfqs.findOne(consumer, id);
  }

  @Post(':id/sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('private-rfqs:write')
  @ApiOperation({ summary: 'Synchronize lifecycle state from Sub Rosa' })
  @ApiOkResponse({ type: PrivateRfqEntity })
  sync(@CurrentConsumer() consumer: GatewayConsumer, @Param('id') id: string) {
    return this.privateRfqs.sync(consumer, id);
  }

  @Post(':id/select')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('private-rfqs:write')
  @ApiOperation({ summary: 'Select a valid provider after reveal' })
  @ApiOkResponse({ type: PrivateRfqEntity })
  select(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: SelectPrivateQuoteDto,
  ) {
    return this.privateRfqs.select(consumer, id, dto.provider);
  }

  @Post(':id/payment-intent')
  @RequirePermissions('private-rfqs:write', 'payments:write')
  @ApiOperation({
    summary: 'Create a Cosmos Pay intent for the selected quote',
  })
  @ApiCreatedResponse({ type: PrivateRfqPaymentEntity })
  createPaymentIntent(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: CreateRfqPaymentIntentDto,
  ) {
    return this.privateRfqs.createPaymentIntent(consumer, id, dto);
  }
}
