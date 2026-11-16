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
import {
  PaymentDepositListEntity,
  PaymentRouteCheckListEntity,
} from '@/payment-intents/entities/payment-deposit.entity';
import { PaymentDepositsService } from '@/payment-intents/payment-deposits.service';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import {
  PAYMENT_INTENT_BUILD_RATE_LIMIT,
  PAYMENT_ROUTE_CHECK_RATE_LIMIT,
} from '@/payment-intents/payment-intents.constants';

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

/**
 * The 409s a settlement can end in, shared by the two routes that settle:
 * `validate`, and `PATCH` with `status: SUCCEEDED`, which goes through it.
 */
const SettlementConflictResponse = () =>
  ApiErrorResponse({
    status: 409,
    codes: [
      ApiErrorCode.TransactionAlreadySettled,
      ApiErrorCode.IdempotencyConflict,
      ApiErrorCode.OperationInFlight,
    ],
    description:
      '`transaction_already_settled`: the transaction already settled, or ' +
      'also pays an older, payment intent of any consumer, and one payment ' +
      'settles at most one intent, the oldest it pays; this intent is not ' +
      'paid by it. `idempotency_conflict`: the hash ' +
      'is already recorded on another of your intents. ' +
      '`operation_in_flight`: the status changed under this request; re-read ' +
      'the intent and retry.',
  });

// URI versioning => /v1/payment-intents
@ApiTags('payment-intents')
@Controller({ path: 'payment-intents', version: '1' })
export class PaymentIntentsController {
  constructor(
    private readonly paymentIntents: PaymentIntentsService,
    private readonly deposits: PaymentDepositsService,
  ) {}

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
    description:
      'Stellar only: builds the unsigned envelope paying `destination` from ' +
      "`source` on the key's network (a `prod` key builds for mainnet, a `dev` " +
      'key for testnet), plus a second payment to `merchantFee.wallet` when a ' +
      'merchant fee is set, and answers its XDR, `web+stellar:tx` URI and QR. ' +
      '`memo` (a numeric MEMO_ID, generated when omitted) is the idempotency ' +
      'key: a retry with the same memo and terms returns the stored intent, ' +
      'other terms are `409 idempotency_conflict`. The intent starts ' +
      '`PENDING`, emits `PAYMENT_INTENT_CREATED`, and the on-chain observer ' +
      'settles it when the payment lands.',
  })
  @ApiCreatedResponse({ type: TxPaymentIntentEntity })
  // Loads the payer's account from Horizon to build the envelope, and the
  // destination's for an issued asset, to check it can receive it.
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
    description:
      '`trustline_missing`: the destination does not trust the issued asset ' +
      'being paid. The payer signs this transaction and the destination signs ' +
      'nothing, so only the destination account can add the trustline.',
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
    summary: 'Create a `pay` intent: a payment link and QR on any network',
    description:
      'Answers a link and its QR on `chain`, any network payment links settle ' +
      'on: SEP-7 `web+stellar:pay` on Stellar (the default), Solana Pay on ' +
      "Solana and EIP-681 on Monad, on the key's network (a `prod` key gets " +
      'mainnet, a `dev` key the test networks); on every other network the ' +
      'hosted checkout, where the payer pays a deposit address made for the ' +
      'payment from any network (mainnet only, `amount` required, no ' +
      '`merchantFee` or `callback`). A mainnet link with an amount and no ' +
      'merchant fee can also be paid from another network on Stellar, Solana ' +
      'and Monad. `memo` (numeric, generated when omitted) is the idempotency ' +
      'key: the same memo and terms return the stored intent, other terms are ' +
      '`409 idempotency_conflict`. Emits `PAYMENT_INTENT_CREATED`.',
  })
  @ApiCreatedResponse({ type: PayPaymentIntentEntity })
  // A Solana or Monad intent reads its token's decimals (and Monad's head
  // block) from the chain before it is stored; a link on another network reads
  // the cross-chain route's token list. A Stellar one calls nobody.
  @ApiUpstream('Solana', 'Monad', 'Cross-chain route')
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidAmount,
      ApiErrorCode.InvalidMemo,
      ApiErrorCode.NetworkUnsupported,
      ApiErrorCode.AssetUnsupported,
      ApiErrorCode.MerchantFeeUnsupported,
    ],
    description:
      '`validation_failed`: the body failed validation, or a field the ' +
      'network does not take (`callback` off Stellar, no `amount` where one is ' +
      'required). `invalid_amount`: more decimals than the asset has, or not ' +
      'above zero. `invalid_memo`: not a numeric MEMO_ID. ' +
      '`network_unsupported`: a link on a network paid through deposit ' +
      'addresses needs a `prod` key (mainnet). `asset_unsupported`: the ' +
      'cross-chain route does not trade that asset on that network. ' +
      '`merchant_fee_unsupported`: a merchant fee on such a network, or on ' +
      'Monad without deposit addresses.',
    examples: {
      [ApiErrorCode.NetworkUnsupported]: {
        summary: 'A dev key on a network paid through deposit addresses',
        message:
          'A payment link on Ethereum is paid through a cross-chain payment, which runs on mainnet only: use a prod API key.',
        path: '/v1/payment-intents/pay',
      },
      [ApiErrorCode.AssetUnsupported]: {
        summary: 'The asset is not traded on that network',
        message:
          'The cross-chain route does not support asset "DAI" on base. GET /v1/cross-chain-swaps/assets lists the ones it does.',
        path: '/v1/payment-intents/pay',
      },
      [ApiErrorCode.MerchantFeeUnsupported]: {
        summary: 'A merchant fee on a network paid through deposit addresses',
        message:
          'A payment link on Bitcoin is paid through a deposit address made for each payment, which pays one recipient: a merchant fee is not supported there.',
        path: '/v1/payment-intents/pay',
      },
    },
  })
  @ApiErrorResponse({
    status: 503,
    codes: [ApiErrorCode.ProviderUnavailable, ApiErrorCode.Misconfigured],
    description:
      '`provider_unavailable`: a chain node or the cross-chain route is down ' +
      'or rate limiting this service; retry. `misconfigured`: the plan ' +
      'charges a commission on payments from other networks and this ' +
      'deployment has nowhere to collect it, or a Solana link with a merchant ' +
      'fee and no gateway URL configured.',
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
  @ApiOperation({
    summary: "List the consumer's payment intents",
    description:
      'Newest first, as `{ data, total, take, skip }` with `take` up to 100 ' +
      "(default 20). Only intents on the key's network (a `prod` key lists " +
      'mainnet intents, a `dev` key test-network ones), narrowed by `status`, ' +
      '`chain` and `createdFrom` when given.',
  })
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
    description:
      "The intent's audit trail as an array, oldest first: every status " +
      'change with `fromStatus`, `toStatus`, the `txHash` it carried, its ' +
      '`reason` and the `actor` that made it (`api`, `validate`, `observer` ' +
      'or `system`).',
  })
  @ApiOkResponse({ type: PaymentIntentTransitionEntity, isArray: true })
  listTransitions(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.paymentIntents.listTransitions(consumer, id);
  }

  @Get(':id/deposits')
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary:
      "List a payment intent's deposit addresses (payments from any network)",
    description:
      'Newest first, at most 50: every deposit address made for a payer of ' +
      'this link through `POST /v1/payment-links/{id}/deposits`, with what was ' +
      'sent from which network, the refund address and how each stands. The ' +
      'one that settled the intent is also named by its `paidFrom`. Only ' +
      "intents on the key's network; a link on a test network has none.",
  })
  @ApiOkResponse({ type: PaymentDepositListEntity })
  listDeposits(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ): Promise<PaymentDepositListEntity> {
    return this.deposits.listForOwner(consumer, id);
  }

  @Get(':id/route-check')
  @RequirePermissions('payments:read')
  @RateLimit(PAYMENT_ROUTE_CHECK_RATE_LIMIT)
  @ApiOperation({
    summary:
      "Check which main origins can pay a payment link's amount right now",
    description:
      'One dry quote per main origin (USDC and USDT on the networks most ' +
      'payers hold them on, and Bitcoin) for the link’s amount and asset. ' +
      'Routes have minimums of their own: an origin that cannot pay the ' +
      'amount comes back `available: false` with the reason. Nothing blocks ' +
      'the link; the hosted checkout disables those origins. Empty for a link ' +
      'without a fixed amount or one that cannot be paid from another network.',
  })
  @ApiOkResponse({ type: PaymentRouteCheckListEntity })
  @ApiUpstream('Cross-chain route')
  routeCheck(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ): Promise<PaymentRouteCheckListEntity> {
    return this.deposits.routeCheck(consumer, id);
  }

  @Get(':id')
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary: 'Get a payment intent by id',
    description:
      'One of the consumer’s intents, on any chain, with its QR rebuilt from ' +
      '`uri`. `status` moves as the on-chain observer settles or expires the ' +
      'intent, which the `PAYMENT_INTENT_*` webhooks also report, so polling ' +
      'this route is optional.',
  })
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
    summary: 'Validate a transaction against the intent and settle it',
    description:
      "Looks `txHash` up on the intent's chain and checks it pays this intent " +
      '(success, destination, asset, amount, memo or reference, age); a match ' +
      'settles it `SUCCEEDED` and emits `PAYMENT_INTENT_SUCCEEDED`. This ' +
      "intent's own payment that failed on-chain marks it `FAILED` " +
      '(`PAYMENT_INTENT_FAILED`); any other mismatch answers `valid: false` ' +
      'with a `reason` and leaves the status unchanged. An `EXPIRED` intent ' +
      'still settles on a verified payment, a `SUCCEEDED` one answers as it ' +
      'is without asking the chain, and one transaction settles at most one ' +
      'intent of any consumer (the oldest it pays).',
  })
  @ApiOkResponse({ type: ValidationOutcomeEntity })
  // Reads the transaction back from the intent's chain.
  @ApiUpstream('Horizon', 'Solana', 'Monad')
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.TransactionRejected,
      ApiErrorCode.InvalidStateTransition,
    ],
  })
  @SettlementConflictResponse()
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
    summary:
      'Update a payment intent (status / txHash / reference / checkoutTheme)',
    description:
      'Send only what changes; `reference` and `checkoutTheme` are accepted ' +
      'in any status. `status: SUCCEEDED` needs a `txHash` and goes through ' +
      'the same on-chain check as `validate` (`400 transaction_rejected` when ' +
      'the chain does not confirm it); other status changes follow the ' +
      'transition graph (`SUCCEEDED`, `FAILED` and `CANCELLED` are final, ' +
      '`EXPIRED` only settles on a verified payment), else ' +
      '`400 invalid_state_transition`. A new `txHash` alone is accepted only ' +
      'while `PENDING` or `SUBMITTED`. Emits `PAYMENT_INTENT_CANCELLED`, ' +
      '`PAYMENT_INTENT_SUCCEEDED` or `PAYMENT_INTENT_FAILED` for those ' +
      'statuses and `PAYMENT_INTENT_UPDATED` otherwise.',
  })
  @ApiOkResponse({ type: PaymentIntentEntity })
  // Setting `txHash` verifies it against the chain before it is stored.
  @ApiUpstream('Horizon', 'Solana', 'Monad')
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidStateTransition,
      ApiErrorCode.TransactionRejected,
    ],
  })
  @SettlementConflictResponse()
  update(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: UpdatePaymentIntentDto,
  ) {
    return this.paymentIntents.update(consumer, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('payments:write')
  @ApiOperation({
    summary: 'Delete a payment intent',
    description:
      'Deletes an intent in any status but `SUCCEEDED` and emits ' +
      '`PAYMENT_INTENT_DELETED`. A paid intent is a settled payment and ' +
      'cannot be deleted (`400 invalid_state_transition`); an intent whose ' +
      'status changes during the delete (it may have just been paid) is ' +
      '`409 operation_in_flight`.',
  })
  @ApiOkResponse({ type: DeletedEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.InvalidStateTransition],
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.OperationInFlight],
    description:
      '`operation_in_flight`: the status changed under this delete. The ' +
      'intent may have just been paid. Re-read it before retrying.',
  })
  remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.paymentIntents.remove(consumer, id);
  }
}
