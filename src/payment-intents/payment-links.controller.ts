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
import { PayerTransactionDto } from '@/payment-intents/dto/payer-transaction.dto';
import { PayerTransactionEntity } from '@/payment-intents/entities/payer-transaction.entity';
import { PublicPaymentLinkEntity } from '@/payment-intents/entities/public-payment-link.entity';
import {
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
}
