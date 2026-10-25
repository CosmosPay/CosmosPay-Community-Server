import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { ConfirmZkPaymentDto } from '@/zk-payments/dto/confirm-zk-payment.dto';
import { ZkCheckoutConfigQueryDto } from '@/zk-payments/dto/zk-checkout-config-query.dto';
import {
  PublicZkPaymentEntity,
  ZkPaymentsConfigEntity,
} from '@/zk-payments/entities/zk-payment.entity';
import { ZkCheckoutService } from '@/zk-payments/zk-checkout.service';
import {
  ZK_PAYMENT_CONFIRM_RATE_LIMIT,
  ZK_PAYMENT_PUBLIC_READ_RATE_LIMIT,
} from '@/zk-payments/zk-payments.constants';

const ID_PARAM = {
  name: 'id',
  description: 'The ZK payment id (a cuid), as the merchant shared it.',
  example: 'cmh4x2k9a0001l70g8v5q3z2w',
};

const NO_STORE_HEADER = {
  'Cache-Control': {
    description: 'Always `no-store`: the status changes live.',
    schema: { type: 'string', example: 'no-store' },
  },
};

/** The 404 of a keyless read: there is no consumer to own or not own the row. */
const NOT_FOUND = ApiErrorResponse({
  status: 404,
  codes: [ApiErrorCode.NotFound],
  description:
    'No ZK payment has this id. The same answer the owner gets from ' +
    '`GET /v1/zk-payments/{id}` for one that never existed.',
  examples: {
    [ApiErrorCode.NotFound]: {
      summary: 'No ZK payment has this id',
      message: 'ZK payment cmh4x2k9a0001l70g8v5q3z2w not found',
      path: '/v1/zk-checkout/cmh4x2k9a0001l70g8v5q3z2w',
    },
  },
});

const NETWORK_UNSUPPORTED_EXAMPLE = {
  [ApiErrorCode.NetworkUnsupported]: {
    summary: "The payment's network no longer runs ZK payments here",
    message:
      'ZK payments are not available on public yet. They run on testnet only ' +
      'for now: use a dev API key.',
    path: '/v1/zk-checkout/cmh4x2k9a0001l70g8v5q3z2w',
  },
};

/**
 * `/v1/zk-checkout`: the payer's half of ZK payments, with no API key.
 *
 * Its own prefix, apart from `/v1/zk-payments`, because the gateway serves a
 * keyless read as a prefix route, which only works when nothing under the
 * prefix needs a key. `@Public()`: there is no consumer here (`ApisixGuard`
 * drops any the client names), every budget is per client address, and this
 * service writes no CORS headers; the gateway route adds them, as it does for
 * `/v1/payment-links`.
 */
@ApiTags('zk-checkout')
@Controller({ path: 'zk-checkout', version: '1' })
export class ZkCheckoutController {
  constructor(private readonly checkout: ZkCheckoutService) {}

  // Declared before `:id`, so `config` is never read as a payment id.
  @Get('config')
  @Public()
  @RateLimit(ZK_PAYMENT_PUBLIC_READ_RATE_LIMIT)
  @ApiOperation({
    summary:
      "A network's ZK payments setup, keyless: token, registries, auditor id, commission, fee account",
    description:
      'The same shape as `GET /v1/zk-payments/config`, built by the same code, ' +
      "for a page with no API key: the merchant's confidential-account page " +
      '(register, balance, withdraw) and the checkout read the contracts they ' +
      'prove against here. Everything in it is public on-chain data. ' +
      '`enabled` is false, and the rest null, on a network where ZK payments ' +
      'do not run yet (mainnet today).',
  })
  @ApiOkResponse({ type: ZkPaymentsConfigEntity })
  config(@Query() query: ZkCheckoutConfigQueryDto): ZkPaymentsConfigEntity {
    return this.checkout.config(query.network);
  }

  @Get(':id')
  @Public()
  @RateLimit(ZK_PAYMENT_PUBLIC_READ_RATE_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read a ZK payment as its payer sees it (no API key)',
    description:
      'For a checkout: the gross amount, the net and the commission, the ' +
      'merchant and the fee account to transfer to, the token and the RPC to ' +
      'prove and submit with, and the live status to poll.\n\n' +
      '**The id is the capability.** Nothing about the owning merchant ' +
      'account, the idempotency key or the settling transactions is returned.',
  })
  @ApiParam(ID_PARAM)
  @ApiOkResponse({ type: PublicZkPaymentEntity, headers: NO_STORE_HEADER })
  @NOT_FOUND
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.NetworkUnsupported],
    description:
      "`network_unsupported`: the payment's network or token is no longer " +
      'served by this deployment.',
    examples: NETWORK_UNSUPPORTED_EXAMPLE,
  })
  findOne(@Param('id') id: string): Promise<PublicZkPaymentEntity> {
    return this.checkout.findPublic(id);
  }

  @Post(':id/confirm')
  @Public()
  @RateLimit(ZK_PAYMENT_CONFIRM_RATE_LIMIT)
  // Settles an existing payment; nothing new comes into existence.
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Confirm a ZK payment with its two confidential transfers, verified on-chain (no API key)',
    description:
      'Reads both transactions back through the Soroban RPC and settles the ' +
      'payment only when: both succeeded and each is a single ' +
      '`confidential_transfer` on the token; both closed while the payment ' +
      'was open (not before it was created, not after `expiresAt`); both come ' +
      'from the same payer; the payment transfer goes to the recipient and ' +
      'the fee transfer to the fee account; and each decrypts with the ' +
      "auditor key, on both auditor channels and against the transfer's " +
      'commitment, to exactly `netAmount` / `feeAmount`. Neither transaction ' +
      'may have settled another ZK payment.\n\n' +
      'Idempotent: the same hashes on a settled payment answer it again. A ' +
      'refusal leaves the payment PENDING, and never says what an amount ' +
      'decrypted to.',
  })
  @ApiParam(ID_PARAM)
  @ApiOkResponse({ type: PublicZkPaymentEntity, headers: NO_STORE_HEADER })
  @ApiUpstream('Soroban RPC')
  @NOT_FOUND
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.TransactionNotFound,
      ApiErrorCode.TransactionRejected,
      ApiErrorCode.PaymentTransferMismatch,
      ApiErrorCode.FeeTransferMismatch,
      ApiErrorCode.PayerMismatch,
      ApiErrorCode.Expired,
      ApiErrorCode.InvalidStateTransition,
      ApiErrorCode.NetworkUnsupported,
    ],
    description:
      '`transaction_not_found`: the RPC has no such transaction yet (retry ' +
      'in a few seconds) or no longer. `transaction_rejected`: it failed ' +
      'on-chain. `payment_transfer_mismatch` / `fee_transfer_mismatch`: that ' +
      'transaction is not the confidential transfer this payment needs (wrong ' +
      'token, shape, recipient, amount, or it closed before the payment ' +
      'existed). `payer_mismatch`: the two transfers come from different ' +
      'accounts. `expired`: a transfer closed after `expiresAt`. ' +
      '`invalid_state_transition`: already settled by other transactions.',
    examples: {
      ...NETWORK_UNSUPPORTED_EXAMPLE,
      [ApiErrorCode.TransactionRejected]: {
        summary: 'The transaction failed on-chain',
        message:
          'The payment transaction 5f0e8a1d3c7b9e2f4a6c8d0b1e3f5a7c9d2b4e6f8a0c1d3e5f7a9b2c4d6e8f0a ' +
          'failed on-chain and moved nothing.',
        path: '/v1/zk-checkout/cmh4x2k9a0001l70g8v5q3z2w/confirm',
      },
      [ApiErrorCode.InvalidStateTransition]: {
        summary: 'Already settled, by other transactions',
        message: 'This ZK payment is already settled, by other transactions.',
        path: '/v1/zk-checkout/cmh4x2k9a0001l70g8v5q3z2w/confirm',
      },
    },
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.TransactionAlreadySettled],
    description:
      '`transaction_already_settled`: one of the transactions already ' +
      'settled another ZK payment, of any merchant. One transaction settles ' +
      'at most one payment.',
    examples: {
      [ApiErrorCode.TransactionAlreadySettled]: {
        summary: 'A transaction already settled another ZK payment',
        message:
          'One of these transactions already settled another ZK payment. One ' +
          'transaction settles at most one payment.',
        path: '/v1/zk-checkout/cmh4x2k9a0001l70g8v5q3z2w/confirm',
      },
    },
  })
  confirm(
    @Param('id') id: string,
    @Body() dto: ConfirmZkPaymentDto,
  ): Promise<PublicZkPaymentEntity> {
    return this.checkout.confirm(id, dto);
  }
}
