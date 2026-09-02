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
  Req,
} from '@nestjs/common';
import { WidePaginationQueryDto } from '../../common/dto/pagination.query.dto';
import type { Request } from 'express';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '../../common/decorators/current-consumer.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '../../common/interfaces/gateway-consumer.interface';
import { ReceiversService, resolveTosCooldownMs } from './receivers.service';
import { CreateReceiverDto } from './dto/create-receiver.dto';
import { UpdateReceiverDto } from './dto/update-receiver.dto';
import { RequestTosDto } from './dto/request-tos.dto';
import { ApproveReceiverDto } from './dto/approve-receiver.dto';
import { EnableReceiverDto } from './dto/enable-receiver.dto';
import { SetAccessDto } from './dto/set-access.dto';
import { ReceiverEntity, ReceiverListEntity } from './entities/receiver.entity';

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
  @ApiOkResponse({ type: ReceiverListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: WidePaginationQueryDto,
  ) {
    return this.receivers.findAll(consumer, query);
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

  @Post(':id/approve')
  @RequirePermissions('kyc:write')
  // Approving advances an existing receiver's review state; the receiver was
  // created by POST /v1/kyc/receivers. Nothing new comes into existence here,
  // so 200 — which is what @ApiOkResponse below has always promised, while
  // Nest's POST default silently returned 201.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Approve a pending-review receiver (admin-only review gate); sends the customer the terms link and returns it',
  })
  @ApiOkResponse({ description: 'Receiver approved; terms link returned' })
  @ApiResponse({
    status: 403,
    description:
      'The API key is not elevated (admin role). A key may submit KYC data or approve it, not both.',
  })
  @ApiResponse({
    status: 409,
    description:
      "Invalid KYC status transition (e.g. receiver is not in 'pending_review')",
  })
  approve(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: ApproveReceiverDto,
  ) {
    return this.receivers.approve(consumer, id, dto.redirect_url);
  }

  @Post(':id/tos')
  @RequirePermissions('kyc:write')
  @ApiOperation({
    summary:
      "Request a terms-of-service link for a receiver ('code' returns the URL; 'email' sends it, max once/day)",
  })
  requestTos(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: RequestTosDto,
    // The dashboard's role-derived resend cooldown is read off the raw request rather
    // than declared with @Headers(): declaring it published `x-cosmos-internal` /
    // `x-cosmos-tos-cooldown-ms` as REQUIRED parameters of this endpoint in the shipped
    // OpenAPI spec (which /docs serves outside every guard), advertising an internal
    // mechanism and telling integrators to send two headers that are not theirs to send.
    // The value is only a request — ReceiversService.requestTos honours it solely for an
    // elevated consumer.
    @Req() request: Request,
  ) {
    return this.receivers.requestTos(
      consumer,
      id,
      dto,
      resolveTosCooldownMs(
        request.headers['x-cosmos-internal'],
        request.headers['x-cosmos-tos-cooldown-ms'],
      ),
    );
  }

  @Post(':id/enable')
  @RequirePermissions('kyc:write')
  // Enabling flips a flag on an existing receiver; see the note on approve.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Enable an inactive receiver with an accepted terms-of-service id',
  })
  @ApiOkResponse({ type: ReceiverEntity })
  @ApiResponse({
    status: 409,
    description:
      "Invalid KYC status transition (e.g. receiver is not in 'pending_user')",
  })
  enable(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: EnableReceiverDto,
  ) {
    return this.receivers.enable(consumer, id, dto.tos_id);
  }

  @Patch(':id/access')
  @RequirePermissions('kyc:write')
  @ApiOperation({
    summary:
      'Enable or disable a fiat account (admin-only kill-switch for onramp/offramp)',
  })
  @ApiOkResponse({ type: ReceiverEntity })
  @ApiResponse({
    status: 403,
    description:
      'The API key is not elevated (admin role); a tenant key cannot lift a kill-switch an operator applied.',
  })
  setAccess(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: SetAccessDto,
  ) {
    return this.receivers.setAccess(consumer, id, dto.disabled);
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
