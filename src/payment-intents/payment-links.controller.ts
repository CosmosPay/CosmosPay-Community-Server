import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
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
import { CheckoutEventDto } from '@/payment-intents/dto/checkout-event.dto';
import { PayerTransactionDto } from '@/payment-intents/dto/payer-transaction.dto';
import { SolanaPayAccountDto } from '@/payment-intents/dto/solana-pay-account.dto';
import {
  SolanaPayInfoEntity,
  SolanaPayTransactionEntity,
} from '@/payment-intents/entities/solana-pay.entity';
import { PayerTransactionEntity } from '@/payment-intents/entities/payer-transaction.entity';
import { PublicPaymentLinkEntity } from '@/payment-intents/entities/public-payment-link.entity';
import {
  PAYMENT_LINK_EVENT_RATE_LIMIT,
  PAYMENT_LINK_READ_RATE_LIMIT,
  PAYMENT_LINK_TRANSACTION_RATE_LIMIT,
} from '@/payment-intents/payment-intents.constants';
import { PaymentLinksService } from '@/payment-intents/payment-links.service';

/**
 * `GET /v1/payment-links/{id}` — what a hosted checkout page reads to show a
 * payer their payment and follow it to the end.
 *
 * `@Public()` because the page is a public frontend with no API key and no
 * gateway secret, so there is no consumer here (`ApisixGuard` drops any the
 * client names) and nothing may be read per consumer. The budget is per client
 * address for the same reason. What it answers is `PublicPaymentLinkEntity`,
 * never the owner's view of the intent.
 */
@ApiTags('payment-links')
@Controller({ path: 'payment-links', version: '1' })
export class PaymentLinksController {
  constructor(private readonly paymentLinks: PaymentLinksService) {}

  @Get(':id')
  @Public()
  @RateLimit(PAYMENT_LINK_READ_RATE_LIMIT)
  // The status changes while the page is open; a cached copy would show a paid
  // intent as pending.
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read a payment link as its payer sees it (no API key)',
    description:
      'For a hosted checkout page: amount, asset, network, the address to pay ' +
      '(`payTo`), the link and its QR, and the live status, so the page can ' +
      'poll until the payment settles. Reachable without an API key or the ' +
      'gateway secret.\n\n' +
      '**The id is the capability.** Anyone who holds a payment link can read ' +
      'it here, which is what a payment link is for. Nothing about the owning ' +
      'merchant account, the payer’s own account, the envelope, the ' +
      'merchant’s `reference` or `callback`, or the status history is ' +
      'returned. `uri` is the link verbatim, so whatever the wallet needs ' +
      'from it is in it.\n\n' +
      'Answered with `Cache-Control: no-store`. Budgeted per client address ' +
      '(`x-cosmos-rate-limit`): poll at most every few seconds and honour ' +
      '`Retry-After`.',
  })
  @ApiParam({
    name: 'id',
    description:
      'The payment intent id (a cuid), as in the link ' +
      '`https://payments.cosmospay.lat/<id>`.',
    example: 'cmh4x2k9a0001l70g8v5q3z2w',
  })
  @ApiOkResponse({
    type: PublicPaymentLinkEntity,
    headers: {
      'Cache-Control': {
        description: 'Always `no-store`: the status changes live.',
        schema: { type: 'string', example: 'no-store' },
      },
    },
  })
  // The shared 404 says "or it belongs to another consumer", which is true of
  // the tenant reads and not of this one: there is no consumer here.
  @ApiErrorResponse({
    status: 404,
    codes: [ApiErrorCode.NotFound],
    description:
      'No payment intent has this id: it never existed or it was deleted. ' +
      'The two are the same answer, and the same one ' +
      '`GET /v1/payment-intents/{id}` gives its owner.',
    examples: {
      [ApiErrorCode.NotFound]: {
        summary: 'No payment intent has this id',
        message: 'Payment intent cmh4x2k9a0001l70g8v5q3z2w not found',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w',
      },
    },
  })
  findOne(@Param('id') id: string): Promise<PublicPaymentLinkEntity> {
    return this.paymentLinks.findPublic(id);
  }

  @Post(':id/transaction')
  @Public()
  @RateLimit(PAYMENT_LINK_TRANSACTION_RATE_LIMIT)
  // Builds an envelope for the payer; nothing new is stored.
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Build the envelope a payer signs for a Stellar link with a merchant fee (no API key)',
    description:
      'A SEP-7 `pay` link pays one account, so a Stellar payment link with a ' +
      'merchant fee (`payerAccountRequired` on the link) asks for its payer: ' +
      'given their account, this builds the unsigned envelope with both ' +
      'payments (to the merchant, and the fee to its wallet) and the link’s ' +
      'MEMO_ID, and its `web+stellar:tx` link and QR. The link settles on any ' +
      'transaction that pays both with the memo, so nothing is stored and a ' +
      'lapsed envelope is simply built again.\n\n' +
      'Only for an open link (`PENDING`). Budgeted per client address.',
  })
  @ApiParam({
    name: 'id',
    description: 'The payment intent id, as in the link.',
    example: 'cmh4x2k9a0001l70g8v5q3z2w',
  })
  @ApiOkResponse({ type: PayerTransactionEntity })
  @ApiUpstream('Horizon')
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidStateTransition,
      ApiErrorCode.TrustlineMissing,
    ],
    description:
      '`validation_failed`: the link pays its destination directly (open ' +
      'its `uri`), or `account` is not a Stellar account. ' +
      '`invalid_state_transition`: the link is no longer open. ' +
      '`trustline_missing`: the merchant no longer trusts the asset.',
    examples: {
      [ApiErrorCode.ValidationFailed]: {
        summary: 'The link has its own wallet link',
        message:
          'This payment link pays its destination directly: open its uri',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/transaction',
      },
      [ApiErrorCode.InvalidStateTransition]: {
        summary: 'The link is no longer open',
        message:
          'Payment intent cmh4x2k9a0001l70g8v5q3z2w is EXPIRED: it can no longer be paid',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/transaction',
      },
    },
  })
  @ApiErrorResponse({
    status: 404,
    codes: [ApiErrorCode.NotFound],
    description: 'No payment intent has this id.',
    examples: {
      [ApiErrorCode.NotFound]: {
        summary: 'No payment intent has this id',
        message: 'Payment intent cmh4x2k9a0001l70g8v5q3z2w not found',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/transaction',
      },
    },
  })
  transaction(
    @Param('id') id: string,
    @Body() dto: PayerTransactionDto,
  ): Promise<PayerTransactionEntity> {
    return this.paymentLinks.payerTransaction(id, dto.account);
  }

  @Post(':id/events')
  @Public()
  @RateLimit(PAYMENT_LINK_EVENT_RATE_LIMIT)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Report what the payer did with a wallet from the hosted checkout (no API key)',
    description:
      'The hosted checkout tells what the payer did with a wallet while the ' +
      'link is pending: `walletOpened` (the wallet link, the web wallet, the ' +
      'extension or Freighter was opened), `walletClosed` (the wallet came back ' +
      'without paying) and `sent` (the page saw the wallet send the payment). ' +
      'The owner reads them as `checkoutWalletAt`, `checkoutWalletClosedAt` and ' +
      '`checkoutSentAt` on the intent, to follow a payment that is not on-chain ' +
      'yet.\n\n' +
      '**Informational only:** the status changes on what the chain says, never ' +
      'on these. An event for a link that is no longer pending is ignored. ' +
      'Budgeted per client address.',
  })
  @ApiParam({
    name: 'id',
    description: 'The payment intent id, as in the link.',
    example: 'cmh4x2k9a0001l70g8v5q3z2w',
  })
  @ApiNoContentResponse({
    description: 'Noted (or ignored: the link is not pending).',
  })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed],
    description: '`event` is not one of the three.',
    examples: {
      [ApiErrorCode.ValidationFailed]: {
        summary: 'An unknown event',
        message:
          'event must be one of the following values: walletOpened, walletClosed, sent',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/events',
      },
    },
  })
  @ApiErrorResponse({
    status: 404,
    codes: [ApiErrorCode.NotFound],
    description: 'No payment intent has this id.',
    examples: {
      [ApiErrorCode.NotFound]: {
        summary: 'No payment intent has this id',
        message: 'Payment intent cmh4x2k9a0001l70g8v5q3z2w not found',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/events',
      },
    },
  })
  event(@Param('id') id: string, @Body() dto: CheckoutEventDto): Promise<void> {
    return this.paymentLinks.recordEvent(id, dto.event);
  }

  @Get(':id/solana-pay')
  @Public()
  @RateLimit(PAYMENT_LINK_READ_RATE_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Solana Pay transaction request, GET: the label and icon a wallet shows (no API key)',
    description:
      'A Solana payment link with a merchant fee is a Solana Pay transaction ' +
      'request (`solana:<this URL>`), because a transfer request names one ' +
      'recipient. A wallet reads this first, then POSTs the payer’s account.',
  })
  @ApiParam({
    name: 'id',
    description: 'The payment intent id.',
    example: 'cmh4x2k9a0001l70g8v5q3z2w',
  })
  @ApiOkResponse({ type: SolanaPayInfoEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.InvalidStateTransition],
    description:
      '`validation_failed`: the link is not a Solana Pay transaction request ' +
      '(only a Solana link with a merchant fee is), or `account` is not a ' +
      'Solana address. `invalid_state_transition`: the link is no longer open.',
    examples: {
      [ApiErrorCode.ValidationFailed]: {
        summary: 'Not a transaction request',
        message:
          'This payment link is not a Solana Pay transaction request: open its uri',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/solana-pay',
      },
      [ApiErrorCode.InvalidStateTransition]: {
        summary: 'The link is no longer open',
        message:
          'Payment intent cmh4x2k9a0001l70g8v5q3z2w is EXPIRED: it can no longer be paid',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/solana-pay',
      },
    },
  })
  @ApiErrorResponse({
    status: 404,
    codes: [ApiErrorCode.NotFound],
    description: 'No payment intent has this id.',
    examples: {
      [ApiErrorCode.NotFound]: {
        summary: 'No payment intent has this id',
        message: 'Payment intent cmh4x2k9a0001l70g8v5q3z2w not found',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/solana-pay',
      },
    },
  })
  solanaPayInfo(@Param('id') id: string): Promise<SolanaPayInfoEntity> {
    return this.paymentLinks.solanaPayInfo(id);
  }

  @Post(':id/solana-pay')
  @Public()
  @RateLimit(PAYMENT_LINK_TRANSACTION_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Solana Pay transaction request, POST: the transaction the payer signs (no API key)',
    description:
      'Given the payer’s `account`, the unsigned transaction (base64) with ' +
      'the link’s memo, the transfer to the merchant carrying the link’s ' +
      'reference, and the merchant fee’s transfer to its wallet (creating ' +
      'their token accounts first when missing, paid by the payer). The link ' +
      'settles from the ledger, found by its reference; nothing is stored. ' +
      'Only for an open link.',
  })
  @ApiParam({
    name: 'id',
    description: 'The payment intent id.',
    example: 'cmh4x2k9a0001l70g8v5q3z2w',
  })
  @ApiOkResponse({ type: SolanaPayTransactionEntity })
  @ApiUpstream('Solana')
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.InvalidStateTransition],
    description:
      '`validation_failed`: the link is not a Solana Pay transaction request ' +
      '(only a Solana link with a merchant fee is), or `account` is not a ' +
      'Solana address. `invalid_state_transition`: the link is no longer open.',
    examples: {
      [ApiErrorCode.ValidationFailed]: {
        summary: 'Not a transaction request',
        message:
          'This payment link is not a Solana Pay transaction request: open its uri',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/solana-pay',
      },
      [ApiErrorCode.InvalidStateTransition]: {
        summary: 'The link is no longer open',
        message:
          'Payment intent cmh4x2k9a0001l70g8v5q3z2w is EXPIRED: it can no longer be paid',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/solana-pay',
      },
    },
  })
  @ApiErrorResponse({
    status: 404,
    codes: [ApiErrorCode.NotFound],
    description: 'No payment intent has this id.',
    examples: {
      [ApiErrorCode.NotFound]: {
        summary: 'No payment intent has this id',
        message: 'Payment intent cmh4x2k9a0001l70g8v5q3z2w not found',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/solana-pay',
      },
    },
  })
  solanaPayTransaction(
    @Param('id') id: string,
    @Body() dto: SolanaPayAccountDto,
  ): Promise<SolanaPayTransactionEntity> {
    return this.paymentLinks.solanaPayTransaction(id, dto.account);
  }
}
