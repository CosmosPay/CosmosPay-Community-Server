import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '../../common/decorators/current-consumer.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '../../common/interfaces/gateway-consumer.interface';
import { ReceiversService } from './receivers.service';
import { CreateReceiverDto } from './dto/create-receiver.dto';
import { UpdateReceiverDto } from './dto/update-receiver.dto';
import { ReceiverEntity } from './entities/receiver.entity';

// /v1/kyc/receivers — the KYC/KYB entities required before any onramp/offramp.
@ApiTags('kyc')
@Controller({ path: 'kyc/receivers', version: '1' })
export class ReceiversController {
  constructor(private readonly receivers: ReceiversService) {}

  @Post()
  @RequirePermissions('kyc:write')
  @ApiOperation({ summary: 'Create a receiver (start KYC/KYB)' })
  @ApiCreatedResponse({ type: ReceiverEntity })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateReceiverDto,
  ) {
    return this.receivers.create(consumer, dto);
  }

  @Get()
  @RequirePermissions('kyc:read')
  @ApiOperation({ summary: "List the consumer's receivers" })
  @ApiOkResponse({ type: [ReceiverEntity] })
  findAll(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.receivers.findAll(consumer);
  }

  @Get(':id')
  @RequirePermissions('kyc:read')
  @ApiOperation({
    summary: 'Get a receiver (refreshes KYC status from BlindPay)',
  })
  @ApiOkResponse({ type: ReceiverEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.receivers.findOne(consumer, id);
  }

  @Patch(':id')
  @RequirePermissions('kyc:write')
  @ApiOperation({ summary: 'Update a receiver' })
  @ApiOkResponse({ type: ReceiverEntity })
  update(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: UpdateReceiverDto,
  ) {
    return this.receivers.update(consumer, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('kyc:write')
  @ApiOperation({ summary: 'Delete a receiver' })
  remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.receivers.remove(consumer, id);
  }
}
