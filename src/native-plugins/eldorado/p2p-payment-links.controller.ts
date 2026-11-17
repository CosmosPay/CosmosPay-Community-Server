import { Body, Controller, Get, Header, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
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
import {
  OpenP2pPaymentRequestSessionDto,
  P2pPaymentRequestParamsDto,
} from '@/native-plugins/eldorado/dto/p2p-payment-request.dto';
import {
  P2P_PAYMENT_LINK_READ_RATE_LIMIT,
  P2P_PAYMENT_LINK_SESSION_RATE_LIMIT,
} from '@/native-plugins/eldorado/eldorado.constants';
import {
  P2pPaymentRequestSessionEntity,
  PublicP2pPaymentRequestEntity,
} from '@/native-plugins/eldorado/entities/p2p-payment-request.entity';
import { P2pPaymentRequestsService } from '@/native-plugins/eldorado/p2p-payment-requests.service';

const ID = 'cmh4x2k9a0001l70g8v5q3z2w';
const BASE = `/v1/payment-links/fiat/${ID}`;

const IdParam = () =>
  ApiParam({
    name: 'id',
    description:
      'The payment request id, as in its page `https://payments.cosmospay.lat/fiat/<id>`.',
    example: ID,
  });

/** The 404 of a request read by its id alone: there is no consumer here. */
const RequestNotFound = (path: string) =>
  ApiErrorResponse({
    status: 404,
    codes: [ApiErrorCode.NotFound],
    description: 'No payment request has this id.',
    examples: {
      [ApiErrorCode.NotFound]: { message: 'Payment request not found', path },
    },
  });

/**
 * `/v1/payment-links/fiat/{id}`: the payer's side of a payment request, what
 * the hosted page calls from the payer's browser.
 *
 * Every route is `@Public()`: the page has no API key and no gateway secret, so
 * there is no consumer here (`ApisixGuard` drops any the client names). The id
 * is the capability, budgets are per client address, and the answers never
 * carry the owner, the seller's address, the record token, sessions or
 * transactions. Under `/v1/payment-links`, whose keyless gateway route already
 * serves it; the `fiat/` segment keeps it apart from the payment links' own
 * `{id}` routes.
 */
@ApiTags('payment-links')
@Controller({ path: 'payment-links/fiat', version: '1' })
export class P2pPaymentLinksController {
  constructor(private readonly requests: P2pPaymentRequestsService) {}

  @Get(':id')
  @Public()
  @RateLimit(P2P_PAYMENT_LINK_READ_RATE_LIMIT)
  // The status changes while the page is open.
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read a charge in local money as its payer sees it (no API key)',
    description:
      'For the hosted page of a payment request: the amount in local money, the description, the token the seller receives with an estimate at ' +
      'the market price right now, and the payment methods that can pay it. **The id is the capability**: nothing about the seller’s account or ' +
      'address is returned. Poll it until `status` is no longer `open`. Answered with `Cache-Control: no-store` and budgeted per client address.',
  })
  @IdParam()
  @ApiOkResponse({
    type: PublicP2pPaymentRequestEntity,
    headers: {
      'Cache-Control': {
        description: 'Always `no-store`: the status changes live.',
        schema: { type: 'string', example: 'no-store' },
      },
    },
  })
  @RequestNotFound(BASE)
  findOne(@Param() params: P2pPaymentRequestParamsDto) {
    return this.requests.findPublic(params.id);
  }

  @Post(':id/sessions')
  @Public()
  @RateLimit(P2P_PAYMENT_LINK_SESSION_RATE_LIMIT)
  @Header('Cache-Control', 'no-store')
  // Checks the purchase against the market, which may be read first.
  @ApiUpstream('P2P marketplace')
  @ApiOperation({
    summary: 'Start paying a charge in local money (no API key)',
    description:
      'Opens a purchase of the request’s exact amount, delivered to the seller, paid with `paymentMethod`, and answers `widgetUrl`: open it in a ' +
      'tab or window (claim the tab before the call, so no popup blocker stops it), where the payer signs in, verifies their identity and pays. ' +
      'Starting again opens another purchase; the first one to complete pays the request. `409 request_closed` once the request is paid, cancelled ' +
      'or expired; `400 validation_failed` for a payment method the market does not offer for the currency.',
  })
  @IdParam()
  @ApiCreatedResponse({ type: P2pPaymentRequestSessionEntity })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.RequestClosed],
    description: 'The request was paid, cancelled, or it expired.',
    examples: {
      [ApiErrorCode.RequestClosed]: {
        message: `Payment request ${ID} is expired: it can no longer be paid`,
        path: `${BASE}/sessions`,
      },
    },
  })
  @RequestNotFound(`${BASE}/sessions`)
  openSession(
    @Param() params: P2pPaymentRequestParamsDto,
    @Body() dto: OpenP2pPaymentRequestSessionDto,
  ) {
    return this.requests.openPayerSession(params.id, dto.paymentMethod);
  }
}
