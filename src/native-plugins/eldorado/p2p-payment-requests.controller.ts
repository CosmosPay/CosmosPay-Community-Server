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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiRecordTokenHeader } from '@/common/decorators/api-record-token.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { WidePaginationQueryDto } from '@/common/dto/pagination.query.dto';
import { ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { RECORD_TOKEN_HEADER } from '@/common/public-record-token.constants';
import { headerValue } from '@/common/request-header';
import {
  CreateP2pPaymentRequestDto,
  P2pPaymentRequestParamsDto,
} from '@/native-plugins/eldorado/dto/p2p-payment-request.dto';
import { P2P_PAYMENT_REQUEST_RATE_LIMIT } from '@/native-plugins/eldorado/eldorado.constants';
import {
  P2pPaymentRequestCreatedEntity,
  P2pPaymentRequestEntity,
  P2pPaymentRequestListEntity,
} from '@/native-plugins/eldorado/entities/p2p-payment-request.entity';
import { P2pPaymentRequestsService } from '@/native-plugins/eldorado/p2p-payment-requests.service';

const ID = 'cmh4x2k9a0001l70g8v5q3z2w';

// /v1/onramp/p2p/payment-requests: charges in local money a seller shows as a
// QR, paid through the P2P marketplace straight to the seller's wallet.
@ApiTags('p2p-onramp')
@Controller({ path: 'onramp/p2p/payment-requests', version: '1' })
export class P2pPaymentRequestsController {
  constructor(private readonly requests: P2pPaymentRequestsService) {}

  @Post()
  // Checks the terms against the market, which may be read first.
  @ApiUpstream('P2P marketplace')
  @RequirePermissions('onramp:write')
  // A wallet with no account charges too; the row is read back only with its
  // record token, and the list stays closed to the shared key.
  @AllowPublicKey()
  @RateLimit(P2P_PAYMENT_REQUEST_RATE_LIMIT)
  @ApiOperation({
    summary: 'Charge in local money with a QR',
    description:
      'Creates a payment request: show its `url` (or `qr`) to the payer, who pays `amount` of `currency` with a local method in a hosted window, ' +
      'and the token is delivered by the P2P marketplace straight to `address` on `chainId`; Cosmos Pay never holds the money. ' +
      'The terms are checked against the market like a purchase (`400 validation_failed` with the reason), on the key’s network, and the request ' +
      'can be paid until `expiresAt`. The shared public key also gets `publicToken`, the only way it reads the request back.',
  })
  @ApiCreatedResponse({ type: P2pPaymentRequestCreatedEntity })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateP2pPaymentRequestDto,
  ) {
    return this.requests.create(consumer, dto);
  }

  @Get()
  @RequirePermissions('onramp:read')
  @ApiOperation({
    summary: 'List the payment requests in local money',
    description:
      "The payment requests this key's consumer created on the key's network, newest first, from this service's records. " +
      'Paginated with `take` (default 100, max 100) and `skip`; answers `{ data, total, take, skip }`, where `total` counts every matching request.',
  })
  @ApiOkResponse({ type: P2pPaymentRequestListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: WidePaginationQueryDto,
  ) {
    return this.requests.findAll(consumer, query);
  }

  @Get(':id')
  @RequirePermissions('onramp:read')
  @AllowPublicKey()
  @ApiRecordTokenHeader()
  @ApiOperation({
    summary: 'Read a payment request in local money',
    description:
      "One payment request of this key's consumer on the key's network: poll it to learn when it is `paid` (with the token delivered and its transaction). " +
      "Another consumer's request, or one on the other network, is the 404 of a missing one. The shared public key reads a request only with its " +
      '`publicToken` in `X-Record-Token`; without it, or with another request’s, the answer is that 404.',
  })
  @ApiOkResponse({ type: P2pPaymentRequestEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param() params: P2pPaymentRequestParamsDto,
    @Req() req: Request,
  ) {
    return this.requests.findOne(
      consumer,
      params.id,
      headerValue(req, RECORD_TOKEN_HEADER),
    );
  }

  @Post(':id/cancel')
  @RequirePermissions('onramp:write')
  @AllowPublicKey()
  @ApiRecordTokenHeader()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a payment request in local money',
    description:
      'Stops an open request from being paid: its page refuses new payments. A payment already under way in the hosted window may still complete, ' +
      'and the request then reads `paid`. A request that is not open (paid, expired or cancelled) is `409 request_closed`. ' +
      'The shared public key cancels only with the request’s `publicToken` in `X-Record-Token`.',
  })
  @ApiOkResponse({ type: P2pPaymentRequestEntity })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.RequestClosed],
    description: 'The request was already paid, cancelled, or it expired.',
    examples: {
      [ApiErrorCode.RequestClosed]: {
        message: `Payment request ${ID} is paid: only an open one can be cancelled`,
        path: `/v1/onramp/p2p/payment-requests/${ID}/cancel`,
      },
    },
  })
  cancel(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param() params: P2pPaymentRequestParamsDto,
    @Req() req: Request,
  ) {
    return this.requests.cancel(
      consumer,
      params.id,
      headerValue(req, RECORD_TOKEN_HEADER),
    );
  }
}
