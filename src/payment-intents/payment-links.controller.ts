import {
  applyDecorators,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RATE_LIMIT_HEADER } from '@/common/rate-limit.constants';
import { clientIp } from '@/common/client-ip';
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
  PAYMENT_DEPOSIT_ASSETS_RATE_LIMIT,
  PAYMENT_DEPOSIT_CREATE_RATE_LIMIT,
  PAYMENT_DEPOSIT_QUOTE_RATE_LIMIT,
  PAYMENT_DEPOSIT_READ_RATE_LIMIT,
  PAYMENT_LINK_EVENT_RATE_LIMIT,
  PAYMENT_LINK_PAYER_RATE_LIMIT,
  PAYMENT_LINK_READ_RATE_LIMIT,
  PAYMENT_LINK_TRANSACTION_RATE_LIMIT,
} from '@/payment-intents/payment-intents.constants';
import { PaymentLinksService } from '@/payment-intents/payment-links.service';
import {
  CreatePaymentDepositDto,
  PayerContactDto,
  PaymentDepositRequestDto,
} from '@/payment-intents/dto/payment-deposit.dto';
import {
  PaymentDepositAssetsEntity,
  PaymentDepositEntity,
  PaymentDepositQuoteEntity,
} from '@/payment-intents/entities/payment-deposit.entity';
import {
  PaymentDepositBudgetError,
  PaymentDepositsService,
} from '@/payment-intents/payment-deposits.service';

/**
 * The refusals a quote and a deposit share: the link cannot be paid from
 * another network, is no longer open, or names an asset the cross-chain route
 * does not trade; and the 404 of an unknown id. A deposit also checks a
 * Stellar merchant trusts an issued asset before handing out an address.
 */
const DepositRefusals = (route: 'quote' | 'deposits') =>
  applyDecorators(
    ApiErrorResponse({
      status: 400,
      codes: [
        ApiErrorCode.ValidationFailed,
        ApiErrorCode.ProviderError,
        ApiErrorCode.InvalidStateTransition,
        ApiErrorCode.AssetUnsupported,
        ApiErrorCode.InvalidAmount,
        ...(route === 'deposits' ? [ApiErrorCode.TrustlineMissing] : []),
      ],
      description:
        '`validation_failed`: the link cannot be paid from another network, ' +
        'or `refundTo` is not an address of `originChain`. `provider_error`: ' +
        'the cross-chain route refused the payment (a minimum amount, a route ' +
        'it cannot fill); `message` carries its reason. `invalid_state_transition`: ' +
        'the link is no longer open. `asset_unsupported`: the asset sent, or ' +
        "the link's own, is not traded right now. `invalid_amount`: the link's " +
        'amount does not fit its asset.' +
        (route === 'deposits'
          ? ' `trustline_missing`: the Stellar merchant does not trust the ' +
            "link's asset; only that account can add the trustline."
          : ''),
      examples: {
        [ApiErrorCode.ValidationFailed]: {
          summary: 'The link cannot be paid from another network',
          message:
            'This payment link cannot be paid from another network: it carries a merchant fee.',
          path: `/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/${route}`,
        },
        [ApiErrorCode.ProviderError]: {
          summary: 'The cross-chain route refused the payment',
          message:
            'The cross-chain route refused the request: Temporary swap limits: minimum swap amount is $100',
          path: `/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/${route}`,
        },
        [ApiErrorCode.InvalidStateTransition]: {
          summary: 'The link is no longer open',
          message:
            'Payment intent cmh4x2k9a0001l70g8v5q3z2w is SUCCEEDED: it can no longer be paid',
          path: `/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/${route}`,
        },
        [ApiErrorCode.AssetUnsupported]: {
          summary: 'The asset cannot be sent right now',
          message:
            'The cross-chain route does not support asset "DOGE" on tron. GET /v1/cross-chain-swaps/assets lists the ones it does.',
          path: `/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/${route}`,
        },
        [ApiErrorCode.InvalidAmount]: {
          summary: "The link's amount does not fit its asset",
          message:
            "This payment link's amount has more decimal places than USDC allows",
          path: `/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/${route}`,
        },
      },
    }),
    ApiErrorResponse({
      status: 404,
      codes: [ApiErrorCode.NotFound],
      description: 'No payment intent has this id.',
      examples: {
        [ApiErrorCode.NotFound]: {
          summary: 'No payment intent has this id',
          message: 'Payment intent cmh4x2k9a0001l70g8v5q3z2w not found',
          path: `/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/${route}`,
        },
      },
    }),
    ApiErrorResponse({
      status: 503,
      codes: [ApiErrorCode.ProviderUnavailable, ApiErrorCode.Misconfigured],
      description:
        '`provider_unavailable`: the cross-chain route is down or rate ' +
        'limiting this service; retry. `misconfigured`: this deployment ' +
        'cannot collect the commission a payment from another network pays.',
    }),
  );

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
  constructor(
    private readonly paymentLinks: PaymentLinksService,
    private readonly deposits: PaymentDepositsService,
  ) {}

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

  @Post(':id/payer')
  @Public()
  @RateLimit(PAYMENT_LINK_PAYER_RATE_LIMIT)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      "Record the payer's email before they pay, for their receipt (no API key)",
    description:
      'The hosted checkout asks the payer for an email before it shows any way ' +
      'to pay, and records it here with the checkout language: when the ' +
      'payment succeeds, a receipt goes to that address in that language, and ' +
      'the merchant finds the payer among its customers by it (marked as ' +
      'given by the payer, not verified). The latest one recorded on an open ' +
      'link is the one used; a deposit carries its own. Budgeted per client ' +
      'address.',
  })
  @ApiParam({
    name: 'id',
    description: 'The payment intent id, as in the link.',
    example: 'cmh4x2k9a0001l70g8v5q3z2w',
  })
  @ApiNoContentResponse({ description: 'Recorded.' })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.InvalidStateTransition],
    description:
      '`validation_failed`: not an email. `invalid_state_transition`: the link ' +
      'is no longer open.',
    examples: {
      [ApiErrorCode.ValidationFailed]: {
        summary: 'Not an email',
        message: 'email must be an email',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/payer',
      },
      [ApiErrorCode.InvalidStateTransition]: {
        summary: 'The link is no longer open',
        message:
          'Payment intent cmh4x2k9a0001l70g8v5q3z2w is SUCCEEDED: it can no longer be paid',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/payer',
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
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/payer',
      },
    },
  })
  recordPayer(
    @Param('id') id: string,
    @Body() dto: PayerContactDto,
  ): Promise<void> {
    return this.paymentLinks.recordPayer(id, dto);
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

  @Get(':id/deposit-assets')
  @Public()
  @RateLimit(PAYMENT_DEPOSIT_ASSETS_RATE_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'List what a payer can pay a payment link with, from any network (no API key)',
    description:
      'Every network and asset the cross-chain route still trades: a payer ' +
      'picks one, then asks `POST /v1/payment-links/{id}/quote` what paying ' +
      'from it costs. Only for a link that can be paid from another network ' +
      '(`crossChainPayment` on the link); any other is `validation_failed`. ' +
      'Reachable without an API key; budgeted per client address.',
  })
  @ApiParam({
    name: 'id',
    description: 'The payment intent id, as in the link.',
    example: 'cmh4x2k9a0001l70g8v5q3z2w',
  })
  @ApiOkResponse({ type: PaymentDepositAssetsEntity })
  @ApiUpstream('Cross-chain route')
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed],
    description:
      'The link cannot be paid from another network: a test network, no ' +
      'fixed amount, or a merchant fee.',
    examples: {
      [ApiErrorCode.ValidationFailed]: {
        summary: 'The link cannot be paid from another network',
        message:
          'This payment link cannot be paid from another network: it has no fixed amount.',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/deposit-assets',
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
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/deposit-assets',
      },
    },
  })
  depositAssets(@Param('id') id: string): Promise<PaymentDepositAssetsEntity> {
    return this.deposits.assets(id);
  }

  @Post(':id/quote')
  @Public()
  @RateLimit(PAYMENT_DEPOSIT_QUOTE_RATE_LIMIT)
  // A price; nothing new is stored.
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Price paying a payment link from one network and asset (no API key)',
    description:
      'What the payer sends (`origin.amount`, with the fees and a small ' +
      'buffer for price moves in it; the unused part is refunded) for the ' +
      'merchant to receive exactly the link amount in its asset (on a link ' +
      'without one, the `amount` the payer typed). A dry quote: nothing is ' +
      'reserved and nothing is stored. Routes have minimum amounts of their ' +
      'own, refused as `provider_error` with the reason, so a checkout shows ' +
      'it before any deposit address exists. Only for an open link that can be ' +
      'paid from another network; budgeted per client address.',
  })
  @ApiParam({
    name: 'id',
    description: 'The payment intent id, as in the link.',
    example: 'cmh4x2k9a0001l70g8v5q3z2w',
  })
  @ApiOkResponse({ type: PaymentDepositQuoteEntity })
  @ApiUpstream('Cross-chain route')
  @DepositRefusals('quote')
  quote(
    @Param('id') id: string,
    @Body() dto: PaymentDepositRequestDto,
  ): Promise<PaymentDepositQuoteEntity> {
    return this.deposits.quote(id, dto);
  }

  @Post(':id/deposits')
  @Public()
  @RateLimit(PAYMENT_DEPOSIT_CREATE_RATE_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Open a deposit address that pays a payment link from any network (no API key)',
    description:
      'A live quote: an address on `originChain` made for this payment alone, ' +
      'opened only with the payer’s `email` (their receipt goes there). ' +
      'The payer sends `amountIn` of the origin asset there (with `depositMemo` ' +
      'when set) before `expiresAt`; the merchant is paid exactly the link ' +
      'amount, the link turns `SUCCEEDED` and emits `PAYMENT_INTENT_SUCCEEDED`, ' +
      'and a deposit that cannot complete is refunded to `refundTo`. The same ' +
      'origin asset and refund address while an earlier deposit still waits ' +
      'from the same client answers that one. Each client address (an IPv6 ' +
      'caller by its /48) may have two open deposits per link ' +
      '(`409 operation_in_flight`), so no caller can take another payer’s, ' +
      'and a link takes a limited number of new ones every few minutes ' +
      '(`429` with `Retry-After`). Budgeted per client address too.',
  })
  @ApiParam({
    name: 'id',
    description: 'The payment intent id, as in the link.',
    example: 'cmh4x2k9a0001l70g8v5q3z2w',
  })
  @ApiCreatedResponse({ type: PaymentDepositEntity })
  @ApiUpstream('Cross-chain route', 'Horizon')
  @DepositRefusals('deposits')
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.OperationInFlight],
    description:
      'This client address already has two open deposit addresses on the ' +
      'link: pay one of them, or try again once they expire. Other payers are ' +
      'not affected.',
    examples: {
      [ApiErrorCode.OperationInFlight]: {
        summary: 'Too many open deposit addresses from this client',
        message:
          'You already have 2 open deposit addresses for this payment link: pay one of them, or try again once they expire.',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/deposits',
      },
    },
  })
  createDeposit(
    @Param('id') id: string,
    @Body() dto: CreatePaymentDepositDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDepositEntity> {
    // The caller's address, as the trusted proxy saw it: the per-client cap is
    // keyed on it (an IPv6 caller by its /48).
    return this.deposits
      .create(id, dto, clientIp(req))
      .catch((err: unknown) => {
        // The link's creation budget answers like any budget: when to come back.
        if (err instanceof PaymentDepositBudgetError) {
          res.setHeader(RATE_LIMIT_HEADER.retryAfter, err.retryAfterSeconds);
        }
        throw err;
      });
  }

  @Get(':id/deposits/:depositId')
  @Public()
  @RateLimit(PAYMENT_DEPOSIT_READ_RATE_LIMIT)
  // The status changes while the page polls it.
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read one deposit address of a payment link (no API key)',
    description:
      'What the payer sends and where, and how the payment stands, for the ' +
      'checkout to poll every few seconds until it is `SUCCEEDED`, ' +
      '`REFUNDED`, `FAILED` or `EXPIRED`. Both ids are needed; nothing about ' +
      'the merchant is returned. Budgeted per client address.',
  })
  @ApiParam({
    name: 'id',
    description: 'The payment intent id, as in the link.',
    example: 'cmh4x2k9a0001l70g8v5q3z2w',
  })
  @ApiParam({
    name: 'depositId',
    description:
      'The deposit id, as `POST /v1/payment-links/{id}/deposits` answered it.',
    example: 'cm3dep0s1t0001l70g8v5q3z2w',
  })
  @ApiOkResponse({ type: PaymentDepositEntity })
  @ApiErrorResponse({
    status: 404,
    codes: [ApiErrorCode.NotFound],
    description: 'This link has no deposit with this id.',
    examples: {
      [ApiErrorCode.NotFound]: {
        summary: 'No such deposit on this link',
        message: 'Deposit cm3dep0s1t0001l70g8v5q3z2w not found',
        path: '/v1/payment-links/cmh4x2k9a0001l70g8v5q3z2w/deposits/cm3dep0s1t0001l70g8v5q3z2w',
      },
    },
  })
  findDeposit(
    @Param('id') id: string,
    @Param('depositId') depositId: string,
  ): Promise<PaymentDepositEntity> {
    return this.deposits.findPublic(id, depositId);
  }
}
