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
import { WidePaginationQueryDto } from '@/common/dto/pagination.query.dto';
import type { Request } from 'express';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { ReceiversService } from '@/native-plugins/blindpay/kyc/receivers/receivers.service';
import { resolveTosCooldownMs } from '@/native-plugins/blindpay/kyc/receivers/tos-cooldown-header';
import { CreateReceiverDto } from '@/native-plugins/blindpay/kyc/receivers/dto/create-receiver.dto';
import { UpdateReceiverDto } from '@/native-plugins/blindpay/kyc/receivers/dto/update-receiver.dto';
import { RequestTosDto } from '@/native-plugins/blindpay/kyc/receivers/dto/request-tos.dto';
import { ApproveReceiverDto } from '@/native-plugins/blindpay/kyc/receivers/dto/approve-receiver.dto';
import { EnableReceiverDto } from '@/native-plugins/blindpay/kyc/receivers/dto/enable-receiver.dto';
import { SetAccessDto } from '@/native-plugins/blindpay/kyc/receivers/dto/set-access.dto';
import {
  ReceiverApprovalEntity,
  ReceiverDeletedEntity,
  ReceiverEntity,
  ReceiverListEntity,
  ReceiverTosEntity,
} from '@/native-plugins/blindpay/kyc/receivers/entities/receiver.entity';

// /v1/kyc/receivers — the KYC/KYB entities required before any onramp/offramp.
@ApiTags('kyc')
@Controller({ path: 'kyc/receivers', version: '1' })
export class ReceiversController {
  constructor(private readonly receivers: ReceiversService) {}

  @Post()
  // Creates the receiver at BlindPay once its KYC data is approved.
  @ApiUpstream('BlindPay')
  @RequirePermissions('kyc:write')
  @ApiOperation({
    summary: 'Create a receiver (start KYC/KYB)',
    description:
      'Stores the receiver here and sends nothing to BlindPay yet: it is created there only by ' +
      "`POST /v1/kyc/receivers/{id}/enable`, after the review and the customer's acceptance of the terms. " +
      'A body with KYC data (tax id, date of birth, documents, legal name, formation date or owners) starts in ' +
      '`pending_review`, a bare registration in `inactive`. ' +
      "The receiver belongs to the BlindPay instance of the key's network (production for a mainnet key, development otherwise), " +
      'and the stored dossier is never returned.',
  })
  @ApiCreatedResponse({ type: ReceiverEntity })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateReceiverDto,
  ) {
    return this.receivers.create(consumer, dto);
  }

  @Get()
  @RequirePermissions('kyc:read')
  @ApiOperation({
    summary: "List the consumer's receivers",
    description:
      "Reads the local mirror only, newest first, on the BlindPay instance of the key's network. " +
      'Paginated with `take` (default 100, max 100) and `skip`; answers `{ data, total, take, skip }`, ' +
      'where `total` counts every matching receiver. ' +
      'The stored KYC dossier (tax id, documents, owners) is never returned.',
  })
  @ApiOkResponse({ type: ReceiverListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: WidePaginationQueryDto,
  ) {
    return this.receivers.findAll(consumer, query);
  }

  @Get(':id')
  // Refreshes the mirror from BlindPay so the caller sees the live KYC status.
  @ApiUpstream('BlindPay')
  @RequirePermissions('kyc:read')
  @ApiOperation({
    summary: 'Get a receiver (refreshes KYC status from BlindPay)',
    description:
      'For a receiver that already exists at BlindPay, reads it there and updates the local mirror first, ' +
      "so `kycStatus` is BlindPay's current one; when BlindPay cannot be reached, the stored row is answered instead of an error. " +
      'A receiver not yet at BlindPay (`inactive`, `pending_review`, `pending_user`) is answered from the local row.',
  })
  @ApiOkResponse({ type: ReceiverEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.receivers.findOne(consumer, id);
  }

  @Post(':id/approve')
  @ApiUpstream('BlindPay')
  @RequirePermissions('kyc:write')
  // Approving advances an existing receiver's review state; the receiver was
  // created by POST /v1/kyc/receivers. Nothing new comes into existence here,
  // so 200 — which is what @ApiOkResponse below has always promised, while
  // Nest's POST default silently returned 201.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Approve a receiver's KYC review and get its terms-of-service link",
    description:
      'The review gate before anything reaches BlindPay: only a key with the admin role may approve ' +
      '(any other key gets 403 `kyc_review_required`), and only a `pending_review` receiver. ' +
      "It requests BlindPay's hosted terms-of-service link for `redirect_url` (https, on this consumer's allow-list), " +
      "moves the receiver to `pending_user` and returns the link with the receiver's email; nothing is emailed, the caller delivers it. " +
      'Send `expected_version` (the `dossierVersion` you reviewed) so an edit made since is a 409 `kyc_state_invalid` instead of an approval of unreviewed data.',
  })
  @ApiOkResponse({
    description: 'Receiver approved; terms link returned',
    type: ReceiverApprovalEntity,
  })
  @ApiErrorResponse({
    status: 403,
    codes: [ApiErrorCode.KycReviewRequired, ApiErrorCode.InsufficientScope],
    description:
      '`kyc_review_required`: the API key is not elevated (admin role). A key may submit KYC data or approve it, not both.',
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.KycStateInvalid],
    description:
      "`kyc_state_invalid`: the receiver is not in 'pending_review', or the KYC data changed after you read it (`expected_version` names a version that is no longer current). Re-read the receiver, review it again, and approve that version.",
  })
  approve(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: ApproveReceiverDto,
  ) {
    return this.receivers.approve(
      consumer,
      id,
      dto.redirect_url,
      dto.expected_version,
    );
  }

  @Post(':id/tos')
  @ApiUpstream('BlindPay')
  @RequirePermissions('kyc:write')
  @ApiOperation({
    summary: 'Request a terms-of-service link for an approved receiver',
    description:
      'Only for a `pending_user` receiver (approved, terms not yet accepted); any other status is 400 `kyc_state_invalid`. ' +
      "Requests a fresh hosted link from BlindPay for `redirect_url` (https, on this consumer's allow-list) and returns it with the receiver's email. " +
      '`channel: email` sends nothing itself: it records the send, allowed once per 24 hours per receiver ' +
      '(400 `validation_failed` inside that window, 409 `kyc_state_invalid` when two race), and the caller emails the returned link; ' +
      '`channel: code` (the default) has no such limit.',
  })
  @ApiCreatedResponse({ type: ReceiverTosEntity })
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
        consumer.internal === true,
        request.headers['x-cosmos-tos-cooldown-ms'],
      ),
    );
  }

  @Post(':id/enable')
  @ApiUpstream('BlindPay')
  @RequirePermissions('kyc:write')
  // Enabling flips a flag on an existing receiver; see the note on approve.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Enable an inactive receiver with an accepted terms-of-service id',
    description:
      'Creates the receiver at BlindPay: replays the stored registration with the `tos_id` the customer got by accepting the terms, ' +
      "then replaces the local placeholder id with BlindPay's and mirrors BlindPay's KYC status. " +
      'Only a `pending_user` receiver whose current `dossierVersion` is the approved one; otherwise, or when another enable is running, 409 `kyc_state_invalid`. ' +
      'A receiver already at BlindPay is not created again: it is refreshed from BlindPay and returned.',
  })
  @ApiOkResponse({ type: ReceiverEntity })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.KycStateInvalid],
    description:
      "`kyc_state_invalid`: an invalid KYC status transition (e.g. the receiver is not in 'pending_user').",
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
    description:
      'Sets `disabled` on the receiver. While disabled, onramp, offramp and adding wallets, bank accounts or virtual accounts ' +
      'for it are refused with 403 `account_disabled`, whatever its KYC status. ' +
      'Only a key with the admin role may call it (any other key gets 403 `insufficient_scope`), so a tenant cannot lift a switch an operator set. ' +
      'Local only: nothing is sent to BlindPay.',
  })
  @ApiOkResponse({ type: ReceiverEntity })
  @ApiErrorResponse({
    status: 403,
    codes: [ApiErrorCode.InsufficientScope],
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
  // An identity change is rewritten at BlindPay, not only locally.
  @ApiUpstream('BlindPay')
  @RequirePermissions('kyc:write')
  @ApiOperation({
    summary:
      'Update a receiver (once it is at BlindPay, identity fields need an elevated key)',
    description:
      'Before the receiver exists at BlindPay, the patch is merged into the stored registration, any change bumps `dossierVersion`, ' +
      'and editing a `pending_user` receiver (or adding KYC data to an `inactive` one) moves it to `pending_review`. ' +
      'After that the patch is sent to BlindPay, and a key without the admin role may change only `external_id` and `image_url`. ' +
      '`tos_id` is always ignored: the accepted terms cannot be changed.',
  })
  @ApiOkResponse({ type: ReceiverEntity })
  @ApiErrorResponse({
    status: 403,
    codes: [ApiErrorCode.KycReviewRequired],
    description:
      '`kyc_review_required`: the receiver already exists at BlindPay and the patch touches a field other than `external_id` or `image_url`. Only an elevated key (admin role) may rewrite identity at the provider; before enabling, the same edit sends the receiver back to review instead.',
  })
  update(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: UpdateReceiverDto,
  ) {
    return this.receivers.update(consumer, id, dto);
  }

  @Delete(':id')
  @ApiUpstream('BlindPay')
  @RequirePermissions('kyc:write')
  @ApiOperation({
    summary: 'Delete a receiver',
    description:
      'Deletes the receiver at BlindPay when it was ever created there, then the local row, and records the deletion in the audit log. ' +
      'A receiver that never reached BlindPay is deleted locally only.',
  })
  @ApiOkResponse({ type: ReceiverDeletedEntity })
  remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.receivers.remove(consumer, id);
  }
}
