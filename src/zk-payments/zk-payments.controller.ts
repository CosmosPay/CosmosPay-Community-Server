import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
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
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { headerValue } from '@/common/request-header';
import { CreateZkPaymentDto } from '@/zk-payments/dto/create-zk-payment.dto';
import { QueryZkPaymentsDto } from '@/zk-payments/dto/query-zk-payments.dto';
import {
  ZkPaymentEntity,
  ZkPaymentListEntity,
  ZkPaymentsConfigEntity,
} from '@/zk-payments/entities/zk-payment.entity';
import { ZK_PAYMENT_CREATE_RATE_LIMIT } from '@/zk-payments/zk-payments.constants';
import { ZkPaymentsService } from '@/zk-payments/zk-payments.service';

/** The example `network_unsupported` a ZK route really sends. */
export const ZK_NETWORK_UNSUPPORTED_EXAMPLE = {
  [ApiErrorCode.NetworkUnsupported]: {
    summary: 'Private payments do not run on this network yet (mainnet today)',
    message:
      'Private payments are not available on public yet. They run on testnet only ' +
      'for now: use a dev API key.',
    path: '/v1/zk-payments',
  },
};

/**
 * `/v1/zk-payments`: private payments as the merchant's API key sees them. The
 * payer's half (read a payment, confirm it) is keyless, under
 * `/v1/zk-checkout`, so the gateway can serve that whole prefix without a key.
 */
@ApiTags('zk-payments')
@Controller({ path: 'zk-payments', version: '1' })
export class ZkPaymentsController {
  constructor(private readonly zkPayments: ZkPaymentsService) {}

  @Get('config')
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary:
      "The private payments setup of the API key's network: token, registries, auditor id, commission, fee account",
    description:
      'What a dashboard needs to set a merchant up on the confidential token ' +
      '(register, read the balance, withdraw). `enabled` is false on a ' +
      'network where private payments do not run yet (mainnet today). The same ' +
      'shape as the keyless `GET /v1/zk-checkout/config?network=`.',
  })
  @ApiOkResponse({ type: ZkPaymentsConfigEntity })
  getConfig(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.zkPayments.getConfig(consumer);
  }

  @Post()
  @RequirePermissions('payments:write')
  // Reads the recipient's confidential account from the Soroban RPC, which
  // every tenant shares.
  @RateLimit(ZK_PAYMENT_CREATE_RATE_LIMIT)
  @ApiOperation({
    summary:
      'Create a private payment: a confidential payment to a merchant registered on the token, minus the 0.18% commission',
    description:
      'A private payment hides its amount on-chain: it is paid with ' +
      "confidential transfers on Cosmos Pay's confidential token, proven with " +
      'zero-knowledge proofs (hence `zk` in the paths). ' +
      'Prices the payment (`amount` = `netAmount` + `feeAmount`, the fee ' +
      'rounded up and at least one stroop) and checks on-chain that the ' +
      'recipient holds a confidential account on the token under auditor 0. ' +
      'The payer then makes two confidential transfers (net to the merchant, ' +
      'fee to the fee account) and confirms them at ' +
      '`POST /v1/zk-checkout/{id}/confirm`. With a `merchantFee`, a third ' +
      'transfer pays it to its wallet, which must hold a confidential account ' +
      'on the token too.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional idempotency key. A retry with the same key and the same ' +
      'request returns the existing payment; the same key with a different ' +
      'request is 409 idempotency_conflict. Takes precedence over ' +
      'body.idempotencyKey.',
    example: 'order-24',
  })
  @ApiCreatedResponse({ type: ZkPaymentEntity })
  @ApiUpstream('Soroban RPC')
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidAmount,
      ApiErrorCode.RecipientNotRegistered,
      ApiErrorCode.NetworkUnsupported,
    ],
    description:
      '`invalid_amount`: after the commission (and the merchant fee) the ' +
      'merchant would receive nothing, or the merchant fee rounds to nothing. ' +
      "`recipient_not_registered`: the recipient, or the merchant fee's " +
      'wallet, has no confidential account on the token under auditor 0. ' +
      '`network_unsupported`: private payments do not run on this network yet ' +
      '(mainnet today; use a dev key).',
    examples: {
      ...ZK_NETWORK_UNSUPPORTED_EXAMPLE,
      [ApiErrorCode.InvalidAmount]: {
        summary: 'The merchant would receive nothing after the commission',
        message:
          'The amount is too small: after the 0.18% commission (at least one ' +
          'stroop) the merchant would receive nothing.',
        path: '/v1/zk-payments',
      },
    },
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.IdempotencyConflict, ApiErrorCode.OperationInFlight],
    description:
      '`idempotency_conflict`: this key was already used for a different ' +
      'payment. `operation_in_flight`: a concurrent create with the same key ' +
      'changed it while this one ran; retry.',
    examples: {
      [ApiErrorCode.IdempotencyConflict]: {
        message:
          'A private payment with this idempotency key already exists for a ' +
          'different request. Retry with the original request unchanged, or ' +
          'use a new key.',
        path: '/v1/zk-payments',
      },
      [ApiErrorCode.OperationInFlight]: {
        message:
          'A concurrent request for this idempotency key changed it while ' +
          'this one was being created. Retry the request.',
        path: '/v1/zk-payments',
      },
    },
  })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateZkPaymentDto,
    // Read via @Req (not @Headers) so Swagger does not emit a second
    // `idempotency-key` parameter beside @ApiHeader.
    @Req() req: Request,
  ) {
    return this.zkPayments.create(
      consumer,
      dto,
      headerValue(req, 'idempotency-key'),
    );
  }

  @Get()
  @RequirePermissions('payments:read')
  @ApiOperation({ summary: "List the consumer's private payments" })
  @ApiOkResponse({ type: ZkPaymentListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryZkPaymentsDto,
  ) {
    return this.zkPayments.findAll(consumer, query);
  }

  @Get(':id')
  @RequirePermissions('payments:read')
  @ApiOperation({ summary: 'Get a private payment by id' })
  @ApiOkResponse({ type: ZkPaymentEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.zkPayments.findOne(consumer, id);
  }
}
