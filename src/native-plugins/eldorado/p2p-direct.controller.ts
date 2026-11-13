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
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { headerValue } from '@/common/request-header';
import {
  CreateDirectOrderDto,
  DirectKycDetailsDto,
  DirectKycPhoneDto,
  DirectLoginDto,
  DirectLoginVerifyDto,
  P2pDirectOrderParamsDto,
} from '@/native-plugins/eldorado/dto/p2p-direct.dto';
import { P2pPaymentRequestParamsDto } from '@/native-plugins/eldorado/dto/p2p-payment-request.dto';
import {
  P2P_DIRECT_LOGIN_RATE_LIMIT,
  P2P_DIRECT_READ_RATE_LIMIT,
  P2P_DIRECT_SESSION_HEADER,
  P2P_DIRECT_VERIFY_RATE_LIMIT,
  P2P_DIRECT_WRITE_RATE_LIMIT,
} from '@/native-plugins/eldorado/eldorado.constants';
import {
  DirectAccountsEntity,
  DirectKycEntity,
  DirectLoginEntity,
  DirectOrderEntity,
  DirectSessionEntity,
} from '@/native-plugins/eldorado/entities/p2p-direct.entity';
import { P2pDirectService } from '@/native-plugins/eldorado/p2p-direct.service';

const ID = 'cmh4x2k9a0001l70g8v5q3z2w';
const ORDER_ID = '0b8f4c6e-2a71-4c1e-9d3b-5f7a8e9c1d20';
const BASE = `/v1/payment-links/fiat/${ID}/direct`;

const IdParam = () =>
  ApiParam({
    name: 'id',
    description:
      'The payment request id, as in its page `https://payments.cosmospay.lat/fiat/<id>`.',
    example: ID,
  });

const OrderIdParam = () =>
  ApiParam({
    name: 'orderId',
    description: 'The order’s `id`, as `POST .../direct/orders` answered it.',
    example: ORDER_ID,
  });

/** The payer's sealed session, on every route after the sign-in. */
const SessionHeader = () =>
  ApiHeader({
    name: 'X-Payer-Session',
    required: true,
    description:
      'The `session` `POST .../direct/login/verify` answered for this payment request. Missing, altered, expired or issued for another request: `401 session_expired`.',
  });

const SessionExpired = (path: string) =>
  ApiErrorResponse({
    status: 401,
    codes: [ApiErrorCode.SessionExpired],
    description:
      'The payer session is missing, expired, or belongs to another payment request: verify the email again.',
    examples: {
      [ApiErrorCode.SessionExpired]: {
        message: 'The payer session expired: verify your email again.',
        path,
      },
    },
  });

const NotFound = (
  path: string,
  description = 'No payment request has this id.',
) =>
  ApiErrorResponse({
    status: 404,
    codes: [ApiErrorCode.NotFound],
    description,
    examples: {
      [ApiErrorCode.NotFound]: { message: 'Payment request not found', path },
    },
  });

/**
 * The 400s and 409s of the steps that start something on an open request:
 * the DTO's, a request this page cannot pay (`method_unavailable`), a
 * refusal the marketplace gave no mapped reason for (`rejected`), and a
 * request that is no longer open, plus each route's own.
 */
const Startable = (
  path: string,
  extra400: ApiErrorCode[] = [],
  extra409: ApiErrorCode[] = [],
) =>
  applyDecorators(
    ApiErrorResponse({
      status: 400,
      codes: [
        ApiErrorCode.ValidationFailed,
        ApiErrorCode.MethodUnavailable,
        ApiErrorCode.Rejected,
        ...extra400,
      ],
      examples: {
        [ApiErrorCode.MethodUnavailable]: {
          message: `Payment request ${ID} cannot be paid with a transfer to a verified seller from this page`,
          path,
        },
      },
    }),
    ApiErrorResponse({
      status: 409,
      codes: [ApiErrorCode.RequestClosed, ...extra409],
      description:
        extra409.length === 0
          ? 'The request is processing a payment, was paid or cancelled, or it expired.'
          : undefined,
      examples: {
        [ApiErrorCode.RequestClosed]: {
          message: `Payment request ${ID} is paid: it can no longer be paid`,
          path,
        },
      },
    }),
  );

/** The 400s of the routes of an order already under way. */
const OrderRefused = () =>
  ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.Rejected],
  });

const Unavailable = (path: string, codes = [ApiErrorCode.P2pUnavailable]) =>
  ApiErrorResponse({
    status: 503,
    codes,
    examples: {
      [ApiErrorCode.P2pUnavailable]: {
        message:
          'Paying through a verified seller is not available right now: retry shortly or pay with another method.',
        path,
      },
    },
  });

/**
 * `/v1/payment-links/fiat/{id}/direct/*`: the payer of an ARS payment request
 * pays it from the page through a verified seller of the P2P marketplace,
 * without leaving it (`p2pDirect` on the request's read). `@Public()` like the
 * rest of the payer's page, under the keyless gateway route of
 * `/v1/payment-links/*`: no consumer, the request id is the capability,
 * budgets per client address. After the email sign-in every route takes the
 * payer's sealed session in `X-Payer-Session`.
 */
@ApiTags('payment-links')
@Controller({ path: 'payment-links/fiat', version: '1' })
export class P2pDirectController {
  constructor(private readonly direct: P2pDirectService) {}

  @Post(':id/direct/login')
  @Public()
  @RateLimit(P2P_DIRECT_LOGIN_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Start verifying a payer by email (no API key)',
    description:
      'For a request whose `p2pDirect` is true: emails the payer a code (in the language `Accept-Language` prefers among Spanish, English and Portuguese; Spanish by default) and answers the `challenge` to send back with it. ' +
      'A new email also opens the payer’s account. Nothing about the payer is stored. ' +
      '`400 invalid_email`, `400 method_unavailable` when the request cannot be paid this way, `409 request_closed` unless it is open.',
  })
  @IdParam()
  @ApiOkResponse({ type: DirectLoginEntity })
  @Startable(`${BASE}/login`, [ApiErrorCode.InvalidEmail])
  @NotFound(`${BASE}/login`)
  @Unavailable(`${BASE}/login`)
  login(
    @Param() params: P2pPaymentRequestParamsDto,
    @Body() dto: DirectLoginDto,
    @Req() req: Request,
  ) {
    return this.direct.login(
      params.id,
      dto.email,
      headerValue(req, 'accept-language'),
    );
  }

  @Post(':id/direct/login/verify')
  @Public()
  @RateLimit(P2P_DIRECT_VERIFY_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Verify a payer’s emailed code (no API key)',
    description:
      'Trades the emailed code for the payer’s `session` on this request, to send in `X-Payer-Session` on the other `.../direct/*` routes until `expiresAt` (at most two hours). ' +
      '`400 invalid_code` for a wrong or expired code; too many wrong codes lock the email for a while (`429 rate_limited`).',
  })
  @IdParam()
  @ApiOkResponse({ type: DirectSessionEntity })
  @Startable(`${BASE}/login/verify`, [ApiErrorCode.InvalidCode])
  @NotFound(`${BASE}/login/verify`)
  @Unavailable(`${BASE}/login/verify`)
  verify(
    @Param() params: P2pPaymentRequestParamsDto,
    @Body() dto: DirectLoginVerifyDto,
  ) {
    return this.direct.verify(params.id, dto.challenge, dto.code);
  }

  @Get(':id/direct/kyc')
  @Public()
  @RateLimit(P2P_DIRECT_READ_RATE_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Read where a payer stands in verifying their identity (no API key)',
    description:
      'What the page asks next (`step`): the city and phone, the phone’s code, an ID document at `documentUrl`, a review, a refusal, or nothing (`ready`, with what the payer may still pay this month in `limitUsd`). ' +
      'Poll it while the payer verifies their document. Verifying happens once per payer, not per payment.',
  })
  @IdParam()
  @SessionHeader()
  @ApiOkResponse({ type: DirectKycEntity })
  @Startable(`${BASE}/kyc`)
  @SessionExpired(`${BASE}/kyc`)
  @NotFound(`${BASE}/kyc`)
  @Unavailable(`${BASE}/kyc`)
  kyc(@Param() params: P2pPaymentRequestParamsDto, @Req() req: Request) {
    return this.direct.kyc(params.id, this.session(req));
  }

  @Post(':id/direct/kyc/details')
  @Public()
  @RateLimit(P2P_DIRECT_WRITE_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Send a payer’s city and phone (no API key)',
    description:
      'The first verification step, for a payer living in Argentina: their city and their phone, which receives a 4-digit code. Answers where the payer stands now (usually `phone`). ' +
      '`400 invalid_phone` for a number that is not Argentine; a phone another account has comes back as `step: details` with `error: phone_taken`.',
  })
  @IdParam()
  @SessionHeader()
  @ApiOkResponse({ type: DirectKycEntity })
  @Startable(`${BASE}/kyc/details`, [ApiErrorCode.InvalidPhone])
  @SessionExpired(`${BASE}/kyc/details`)
  @NotFound(`${BASE}/kyc/details`)
  @Unavailable(`${BASE}/kyc/details`)
  submitKycDetails(
    @Param() params: P2pPaymentRequestParamsDto,
    @Body() dto: DirectKycDetailsDto,
    @Req() req: Request,
  ) {
    return this.direct.submitKycDetails(
      params.id,
      this.session(req),
      dto.city,
      dto.phone,
    );
  }

  @Post(':id/direct/kyc/phone')
  @Public()
  @RateLimit(P2P_DIRECT_WRITE_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Verify a payer’s phone code (no API key)',
    description:
      'Checks the 4-digit code texted to the phone and answers where the payer stands now (usually `document`). `400 invalid_code` for a wrong one.',
  })
  @IdParam()
  @SessionHeader()
  @ApiOkResponse({ type: DirectKycEntity })
  @Startable(`${BASE}/kyc/phone`, [ApiErrorCode.InvalidCode])
  @SessionExpired(`${BASE}/kyc/phone`)
  @NotFound(`${BASE}/kyc/phone`)
  @Unavailable(`${BASE}/kyc/phone`)
  verifyKycPhone(
    @Param() params: P2pPaymentRequestParamsDto,
    @Body() dto: DirectKycPhoneDto,
    @Req() req: Request,
  ) {
    return this.direct.verifyKycPhone(params.id, this.session(req), dto.code);
  }

  @Get(':id/direct/accounts')
  @Public()
  @RateLimit(P2P_DIRECT_READ_RATE_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'List a payer’s saved bank accounts (no API key)',
    description:
      'The bank accounts in the payer’s own name they paid from before, to pick one instead of typing it again: the holder, the bank and a hint (the alias, or the last four digits), never the full number.',
  })
  @IdParam()
  @SessionHeader()
  @ApiOkResponse({ type: DirectAccountsEntity })
  @Startable(`${BASE}/accounts`)
  @SessionExpired(`${BASE}/accounts`)
  @NotFound(`${BASE}/accounts`)
  @Unavailable(`${BASE}/accounts`)
  accounts(@Param() params: P2pPaymentRequestParamsDto, @Req() req: Request) {
    return this.direct.accounts(params.id, this.session(req));
  }

  @Post(':id/direct/orders')
  @Public()
  @RateLimit(P2P_DIRECT_WRITE_RATE_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Start paying a charge through a verified seller (no API key)',
    description:
      'Opens a payment of the request’s exact amount from the payer’s bank account (`accountId`, or a new `account` in their own name), delivered to the seller. ' +
      'Poll the order: once a seller takes it (`pay`), transfer exactly `amount` to `payTo` before `dueAt`, then mark it paid. Starting again opens another order; the first one to complete pays the request. ' +
      'A refused account answers its field’s code (`invalid_cbu`, `invalid_document`, `invalid_bank`, else `invalid_account`); `409 kyc_required` until the payer is verified, `409 too_many_orders` with two payments of theirs in progress, `503 no_sellers` when nobody can take it now.',
  })
  @IdParam()
  @SessionHeader()
  @ApiCreatedResponse({ type: DirectOrderEntity })
  @Startable(
    `${BASE}/orders`,
    [
      ApiErrorCode.InvalidAccount,
      ApiErrorCode.InvalidCbu,
      ApiErrorCode.InvalidDocument,
      ApiErrorCode.InvalidBank,
    ],
    [ApiErrorCode.KycRequired, ApiErrorCode.TooManyOrders],
  )
  @SessionExpired(`${BASE}/orders`)
  @NotFound(`${BASE}/orders`)
  @Unavailable(`${BASE}/orders`, [
    ApiErrorCode.P2pUnavailable,
    ApiErrorCode.NoSellers,
  ])
  createOrder(
    @Param() params: P2pPaymentRequestParamsDto,
    @Body() dto: CreateDirectOrderDto,
    @Req() req: Request,
  ) {
    return this.direct.createOrder(params.id, this.session(req), dto);
  }

  @Get(':id/direct/orders/:orderId')
  @Public()
  @RateLimit(P2P_DIRECT_READ_RATE_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read a payment to a verified seller (no API key)',
    description:
      'One order of this request, through the payer’s session: poll it while a seller is found (`matching`) and while the transfer is confirmed (`confirming`). ' +
      'It answers whatever the request reads as now, so a payer can follow a payment they started. An order of another request is the 404 of a missing one.',
  })
  @IdParam()
  @OrderIdParam()
  @SessionHeader()
  @ApiOkResponse({ type: DirectOrderEntity })
  @OrderRefused()
  @SessionExpired(`${BASE}/orders/${ORDER_ID}`)
  @NotFound(
    `${BASE}/orders/${ORDER_ID}`,
    'No payment request has this id, or the order is not one of its orders.',
  )
  @Unavailable(`${BASE}/orders/${ORDER_ID}`)
  order(@Param() params: P2pDirectOrderParamsDto, @Req() req: Request) {
    return this.direct.order(params.id, params.orderId, this.session(req));
  }

  @Post(':id/direct/orders/:orderId/paid')
  @Public()
  @RateLimit(P2P_DIRECT_WRITE_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Tell the seller the transfer was made (no API key)',
    description:
      'Only after transferring: the order moves from `pay` to `confirming` and the request reads `processing` until the seller confirms (it turns `paid`) or the order is cancelled (it is open again). ' +
      'It never answers `request_closed`: a payer who transferred can say so whatever the request reads as. `409 order_not_payable` unless the order is waiting for the transfer.',
  })
  @IdParam()
  @OrderIdParam()
  @SessionHeader()
  @ApiOkResponse({ type: DirectOrderEntity })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.OrderNotPayable],
    examples: {
      [ApiErrorCode.OrderNotPayable]: {
        message:
          'This order is matching: only an order waiting for your transfer can be marked paid.',
        path: `${BASE}/orders/${ORDER_ID}/paid`,
      },
    },
  })
  @OrderRefused()
  @SessionExpired(`${BASE}/orders/${ORDER_ID}/paid`)
  @NotFound(
    `${BASE}/orders/${ORDER_ID}/paid`,
    'No payment request has this id, or the order is not one of its orders.',
  )
  @Unavailable(`${BASE}/orders/${ORDER_ID}/paid`)
  markPaid(@Param() params: P2pDirectOrderParamsDto, @Req() req: Request) {
    return this.direct.markPaid(params.id, params.orderId, this.session(req));
  }

  @Post(':id/direct/orders/:orderId/cancel')
  @Public()
  @RateLimit(P2P_DIRECT_WRITE_RATE_LIMIT)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Cancel a payment the payer has not made (no API key)',
    description:
      'Cancels an order still `matching` or waiting for the transfer (`pay`); never one the payer marked paid. It never answers `request_closed`. ' +
      '`409 order_not_cancellable` otherwise.',
  })
  @IdParam()
  @OrderIdParam()
  @SessionHeader()
  @ApiOkResponse({ type: DirectOrderEntity })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.OrderNotCancellable],
    examples: {
      [ApiErrorCode.OrderNotCancellable]: {
        message:
          'This order is confirming: only an order you have not paid yet can be cancelled.',
        path: `${BASE}/orders/${ORDER_ID}/cancel`,
      },
    },
  })
  @OrderRefused()
  @SessionExpired(`${BASE}/orders/${ORDER_ID}/cancel`)
  @NotFound(
    `${BASE}/orders/${ORDER_ID}/cancel`,
    'No payment request has this id, or the order is not one of its orders.',
  )
  @Unavailable(`${BASE}/orders/${ORDER_ID}/cancel`)
  cancel(@Param() params: P2pDirectOrderParamsDto, @Req() req: Request) {
    return this.direct.cancel(params.id, params.orderId, this.session(req));
  }

  private session(req: Request): string | undefined {
    return headerValue(req, P2P_DIRECT_SESSION_HEADER);
  }
}
