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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { CreateTxPaymentIntentDto } from '@/payment-intents/dto/create-tx-payment-intent.dto';
import { CreatePayPaymentIntentDto } from '@/payment-intents/dto/create-pay-payment-intent.dto';
import { QueryPaymentIntentsDto } from '@/payment-intents/dto/query-payment-intents.dto';
import { UpdatePaymentIntentDto } from '@/payment-intents/dto/update-payment-intent.dto';
import { ValidatePaymentIntentDto } from '@/payment-intents/dto/validate-payment-intent.dto';
import {
  DeletedEntity,
  PaymentIntentEntity,
  PaymentIntentListEntity,
  PaymentIntentTransitionEntity,
  PayPaymentIntentEntity,
  TxPaymentIntentEntity,
  ValidationOutcomeEntity,
} from '@/payment-intents/entities/payment-intent.entity';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { PAYMENT_INTENT_BUILD_RATE_LIMIT } from '@/payment-intents/payment-intents.constants';

/**
 * The 409 both creates return, declared per route because nothing central can
 * know that the memo is this resource's idempotency key — and under the shared
 * public key a memo can already be taken by someone else.
 */
const MemoConflictResponse = () =>
  ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.IdempotencyConflict, ApiErrorCode.OperationInFlight],
    description:
      '`idempotency_conflict`: an intent with this `memo` already exists for ' +
      'different payment details. Retry with the original request unchanged, ' +
      'or use a new memo (omit `memo` to have one generated). ' +
      '`operation_in_flight`: a concurrent create for the same memo changed ' +
      'it while this one was being created; retry the request.',
  });

// URI versioning => /v1/payment-intents
@ApiTags('payment-intents')
@Controller({ path: 'payment-intents', version: '1' })
export class PaymentIntentsController {
  constructor(private readonly paymentIntents: PaymentIntentsService) {}

  @Post('tx')
  // Builds a SEP-7 intent from the request.
  @AllowPublicKey()
  @RequirePermissions('payments:write')
  // Reads the payer's account from Horizon and writes a row, on the shared
  // public key where the address is all that separates anonymous wallets.
  @RateLimit(PAYMENT_INTENT_BUILD_RATE_LIMIT)
  @ApiOperation({
    summary:
      'Create a SEP-7 `tx` intent (source known → unsigned XDR + tx URI + QR)',
  })
  @ApiCreatedResponse({ type: TxPaymentIntentEntity })
  // Loads the payer's account from Horizon to build the envelope.
  @ApiUpstream('Horizon')
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidAmount,
      ApiErrorCode.InvalidMemo,
      ApiErrorCode.TrustlineMissing,
      ApiErrorCode.InsufficientBalance,
    ],
  })
  @MemoConflictResponse()
  createTx(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateTxPaymentIntentDto,
  ) {
    return this.paymentIntents.createTx(consumer, dto);
  }

  @Post('pay')
  // Builds a SEP-7 pay link from the request.
  @AllowPublicKey()
  @RequirePermissions('payments:write')
  // Same budget as `tx`: one bucket for the one step they spell two ways.
  @RateLimit(PAYMENT_INTENT_BUILD_RATE_LIMIT)
  @ApiOperation({
    summary: 'Create a SEP-7 `pay` intent (no source → pay URI + QR, no XDR)',
  })
  @ApiCreatedResponse({ type: PayPaymentIntentEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidAmount,
      ApiErrorCode.InvalidMemo,
    ],
  })
  @MemoConflictResponse()
  createPay(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreatePayPaymentIntentDto,
  ) {
    return this.paymentIntents.createPay(consumer, dto);
  }

  @Get()
  @RequirePermissions('payments:read')
  @ApiOperation({ summary: "List the consumer's payment intents" })
  @ApiOkResponse({ type: PaymentIntentListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryPaymentIntentsDto,
  ) {
    return this.paymentIntents.findAll(consumer, query);
  }

  @Get(':id/transitions')
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary: 'List the status-transition history for a payment intent',
  })
  @ApiOkResponse({ type: PaymentIntentTransitionEntity, isArray: true })
  listTransitions(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.paymentIntents.listTransitions(consumer, id);
  }

  @Get(':id')
  @RequirePermissions('payments:read')
  @ApiOperation({ summary: 'Get a payment intent by id' })
  @ApiOkResponse({ type: PaymentIntentEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.paymentIntents.findOne(consumer, id);
  }

  @Post(':id/validate')
  @RequirePermissions('payments:write')
  // Validation reconciles an existing intent against the chain — it creates no
  // resource, so 200. Nest's POST default of 201 contradicted @ApiOkResponse.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Validate a submitted tx against the intent (tx success + destination + amount + memo); finalizes status and fires the event',
  })
  @ApiOkResponse({ type: ValidationOutcomeEntity })
  // Reads the transaction and its operations back from Horizon.
  @ApiUpstream('Horizon')
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.TransactionRejected,
      ApiErrorCode.InvalidStateTransition,
    ],
  })
  validate(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: ValidatePaymentIntentDto,
  ) {
    return this.paymentIntents.validate(consumer, id, dto.txHash);
  }

  @Patch(':id')
  @RequirePermissions('payments:write')
  @ApiOperation({
    summary: 'Update a payment intent (status / txHash / reference)',
  })
  @ApiOkResponse({ type: PaymentIntentEntity })
  // Setting `txHash` verifies it against the chain before it is stored.
  @ApiUpstream('Horizon')
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidStateTransition,
      ApiErrorCode.TransactionRejected,
    ],
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.OperationInFlight],
    description:
      '`operation_in_flight` — the status changed under this update. Re-read ' +
      'the intent and retry.',
  })
  update(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: UpdatePaymentIntentDto,
  ) {
    return this.paymentIntents.update(consumer, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('payments:write')
  @ApiOperation({ summary: 'Delete a payment intent' })
  @ApiOkResponse({ type: DeletedEntity })
  remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.paymentIntents.remove(consumer, id);
  }
}
