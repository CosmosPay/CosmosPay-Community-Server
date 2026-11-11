import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { headerValue } from '@/common/request-header';
import {
  CreateProtectedPaymentDto,
  DisputeProtectedPaymentDto,
  QueryProtectedPaymentsDto,
  ShipProtectedPaymentDto,
  SubmitProtectedPaymentDto,
} from '@/native-plugins/trustless-work/dto/protected-payment.dto';
import {
  ProtectedPaymentBuildEntity,
  ProtectedPaymentEntity,
  ProtectedPaymentListEntity,
  ProtectedPaymentSubmitEntity,
} from '@/native-plugins/trustless-work/entities/protected-payment.entity';
import { ProtectedPaymentsService } from '@/native-plugins/trustless-work/protected-payments.service';
import {
  PROTECTED_PAYMENT_BUILD_RATE_LIMIT,
  PROTECTED_PAYMENT_CREATE_RATE_LIMIT,
  PROTECTED_PAYMENT_SUBMIT_RATE_LIMIT,
} from '@/native-plugins/trustless-work/trustless-work.constants';

const ID = '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10';
const BASE = '/v1/protected-payments';

/** The 400 every merchant build can answer for a payment in the wrong state. */
const StateResponse = (path: string, action: string) =>
  ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.InvalidStateTransition, ApiErrorCode.ProviderError],
    description:
      '`invalid_state_transition`: the payment is not in a state this action ' +
      'can be built from, or the release model gives it to the other party. ' +
      '`provider_error`: the protected-payments service refused the request.',
    examples: {
      [ApiErrorCode.InvalidStateTransition]: {
        message: `Cannot ${action} a protected payment that is AWAITING_FUNDING.`,
        path,
      },
      [ApiErrorCode.ProviderError]: {
        message:
          'The protected-payments service refused the request: amount must be a number',
        path,
      },
    },
  });

/**
 * The merchant's protected payments: a real API key, every read and write
 * filtered by the key's consumer and network. No `@AllowPublicKey()` on any
 * route: the buyer's side is the keyless `/v1/protected-payment-links`.
 */
@ApiTags('Protected payments')
@Controller({ path: 'protected-payments', version: '1' })
export class ProtectedPaymentsController {
  constructor(private readonly payments: ProtectedPaymentsService) {}

  @Post()
  @RequirePermissions('payments:write')
  @RateLimit(PROTECTED_PAYMENT_CREATE_RATE_LIMIT)
  @ApiOperation({
    summary:
      'Create a protected payment (the buyer pays into a contract until delivery)',
    description:
      'Creates a protected payment in USDC on the key’s network, with the release ' +
      'model and the deadline policy of your choice, and answers `checkoutUrl`, the ' +
      'page to send the buyer. Nothing happens on-chain yet: the contract is deployed ' +
      'when the buyer first funds it. Emits `PROTECTED_PAYMENT_CREATED`; the same ' +
      '`Idempotency-Key` with the same request returns the stored payment.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional idempotency key. A retry with the same key and the same request ' +
      'returns the stored payment unchanged; the same key with a different request ' +
      'is 409 idempotency_conflict. Takes precedence over body.idempotencyKey.',
    example: 'order-1042',
  })
  @ApiCreatedResponse({ type: ProtectedPaymentEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.InvalidAmount],
    description:
      '`validation_failed`: the body fails validation, the buyer is the merchant, ' +
      'or a party is one of the platform accounts. `invalid_amount`: outside 1 to ' +
      '1000000 USDC.',
    examples: {
      [ApiErrorCode.InvalidAmount]: {
        message: 'amount must be from 1 to 1000000 USDC',
        path: BASE,
      },
    },
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.IdempotencyConflict],
    examples: {
      [ApiErrorCode.IdempotencyConflict]: {
        message:
          'This Idempotency-Key was already used for a different protected ' +
          'payment. Use a new key for a new request.',
        path: BASE,
      },
    },
  })
  @ApiErrorResponse({
    status: 503,
    codes: [ApiErrorCode.Misconfigured],
    description:
      'Protected payments are not configured on the key’s network, or the deadline ' +
      'policy needs a resolver this deployment does not have.',
    examples: {
      [ApiErrorCode.Misconfigured]: {
        message:
          'REFUND_BUYER is not available on testnet: this deployment has no ' +
          'automatic resolver key.',
        path: BASE,
      },
    },
  })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateProtectedPaymentDto,
    // Read via @Req so Swagger does not emit a second `idempotency-key` parameter.
    @Req() req: Request,
  ) {
    return this.payments.create(
      consumer,
      dto,
      headerValue(req, 'idempotency-key'),
    );
  }

  @Get()
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary: 'List your protected payments',
    description:
      'Newest first, as `{ data, total, take, skip }` with `take` up to 100 (default ' +
      '20). Only payments on the key’s network, narrowed by `status` when given, ' +
      'as this service last read them from their contracts.',
  })
  @ApiOkResponse({ type: ProtectedPaymentListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryProtectedPaymentsDto,
  ) {
    return this.payments.findAll(consumer, query);
  }

  @Get(':id')
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary: 'Get one of your protected payments',
    description:
      'The payment as this service last read it from its contract (the sync job ' +
      'reads open contracts every 30 seconds), with its fees and `checkoutUrl`.',
  })
  @ApiOkResponse({ type: ProtectedPaymentEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.payments.findOne(consumer, id);
  }

  @Post(':id/ship')
  @RequirePermissions('payments:write')
  @RateLimit(PROTECTED_PAYMENT_BUILD_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @ApiUpstream('Protected-payments service')
  @ApiOperation({
    summary: 'Build the merchant’s "shipped" mark, with tracking evidence',
    description:
      'For a FUNDED payment: the protected-payments service builds the milestone change to ' +
      '`shipped` with `evidence`, which this service checks is exactly that call ' +
      'and records for 15 minutes. Sign it with `merchantAddress` and send it to ' +
      '`POST /v1/protected-payments/submit`.',
  })
  @ApiOkResponse({ type: ProtectedPaymentBuildEntity })
  @StateResponse(`${BASE}/${ID}/ship`, 'ship')
  ship(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: ShipProtectedPaymentDto,
  ) {
    return this.payments.ship(consumer, id, dto.evidence);
  }

  @Post(':id/approve')
  @RequirePermissions('payments:write')
  @RateLimit(PROTECTED_PAYMENT_BUILD_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @ApiUpstream('Protected-payments service')
  @ApiOperation({
    summary: 'Build the merchant’s approval of delivery (MERCHANT_RELEASES)',
    description:
      'Only where the merchant is the approver (`MERCHANT_RELEASES`), for a FUNDED ' +
      'or SHIPPED payment. Answers the checked envelope for `merchantAddress` to ' +
      'sign and submit.',
  })
  @ApiOkResponse({ type: ProtectedPaymentBuildEntity })
  @StateResponse(`${BASE}/${ID}/approve`, 'approve')
  approve(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.payments.approve(consumer, id);
  }

  @Post(':id/release')
  @RequirePermissions('payments:write')
  @RateLimit(PROTECTED_PAYMENT_BUILD_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @ApiUpstream('Protected-payments service')
  @ApiOperation({
    summary: 'Build the release of the funds to the merchant',
    description:
      'Where the merchant releases (`MERCHANT_RELEASES`, ' +
      '`BUYER_APPROVES_MERCHANT_RELEASES`), for an APPROVED payment. The contract ' +
      'pays the amount less 1.95% to `merchantAddress`. Answers the checked envelope ' +
      'to sign and submit.',
  })
  @ApiOkResponse({ type: ProtectedPaymentBuildEntity })
  @StateResponse(`${BASE}/${ID}/release`, 'release')
  release(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.payments.release(consumer, id);
  }

  @Post(':id/dispute')
  @RequirePermissions('payments:write')
  @RateLimit(PROTECTED_PAYMENT_BUILD_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @ApiUpstream('Protected-payments service')
  @ApiOperation({
    summary: 'Build the merchant’s dispute',
    description:
      'For a FUNDED, SHIPPED or APPROVED payment: answers the dispute for ' +
      '`merchantAddress` to sign and submit. `reason` is kept by this service ' +
      'only; Cosmos Pay ops (or the automatic resolver, under an auto deadline ' +
      'policy) then splits the balance between the buyer and the merchant.',
  })
  @ApiOkResponse({ type: ProtectedPaymentBuildEntity })
  @StateResponse(`${BASE}/${ID}/dispute`, 'dispute')
  dispute(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: DisputeProtectedPaymentDto,
  ) {
    return this.payments.dispute(consumer, id, dto.reason ?? null);
  }

  @Post(':id/cancel')
  @RequirePermissions('payments:write')
  @HttpCode(HttpStatus.OK)
  @ApiUpstream('Protected-payments service')
  @ApiOperation({
    summary: 'Cancel a protected payment nobody funded',
    description:
      'Only CREATED, or AWAITING_FUNDING with an empty contract. Refused while a ' +
      'deposit the buyer was handed can still land (it lapses within 15 minutes). ' +
      'Emits `PROTECTED_PAYMENT_CANCELLED`.',
  })
  @ApiOkResponse({ type: ProtectedPaymentEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.InvalidStateTransition],
    examples: {
      [ApiErrorCode.InvalidStateTransition]: {
        message:
          'Cannot cancel a protected payment that is FUNDED: only one nobody ' +
          'funded can be cancelled.',
        path: `${BASE}/${ID}/cancel`,
      },
    },
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.OperationInFlight],
    examples: {
      [ApiErrorCode.OperationInFlight]: {
        message:
          'The buyer holds a deposit for this protected payment that can still ' +
          'land. Retry once it expires (15 minutes at most).',
        path: `${BASE}/${ID}/cancel`,
      },
    },
  })
  cancel(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.payments.cancel(consumer, id);
  }

  @Post('submit')
  @RequirePermissions('payments:write')
  @RateLimit(PROTECTED_PAYMENT_SUBMIT_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @ApiUpstream('Protected-payments service')
  @ApiOperation({
    summary: 'Submit a merchant-signed protected payment transaction',
    description:
      'Relays `xdr` through the protected-payments service only when it is a signed copy of a ' +
      'transaction built for that payment, for `merchantAddress`, on the key’s ' +
      'network, before it expires. Relayed once: the answer is stored and a replay ' +
      'returns it; on `SUCCESS` the payment moves and its webhook is emitted.',
  })
  @ApiOkResponse({ type: ProtectedPaymentSubmitEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.InvalidStateTransition],
    description:
      '`validation_failed`: `xdr` is not an envelope, is a fee bump or carries no ' +
      'signature. `invalid_state_transition`: it expired before it was submitted.',
    examples: {
      [ApiErrorCode.ValidationFailed]: {
        message:
          'xdr carries no signatures; sign the transaction before submitting it',
        path: `${BASE}/submit`,
      },
      [ApiErrorCode.InvalidStateTransition]: {
        message:
          'This protected payment transaction expired before it was submitted ' +
          'and can no longer be relayed. Build a new one.',
        path: `${BASE}/submit`,
      },
    },
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.OperationInFlight],
    examples: {
      [ApiErrorCode.OperationInFlight]: {
        message:
          'This protected payment transaction is already being submitted. Wait ' +
          'for that submit to finish, then submit it again to read its result.',
        path: `${BASE}/submit`,
      },
    },
  })
  submit(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: SubmitProtectedPaymentDto,
  ) {
    return this.payments.submit(consumer, dto.protectedPaymentId, dto.xdr);
  }
}
