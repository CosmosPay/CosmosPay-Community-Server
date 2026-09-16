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
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { API_ERROR_BODY_CONTENT } from '@/common/errors/api-error.entity';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { headerValue } from '@/common/request-header';
import { CreateSwapDto } from '@/swaps/dto/create-swap.dto';
import { QuerySwapsDto } from '@/swaps/dto/query-swaps.dto';
import { QuoteSwapDto } from '@/swaps/dto/quote-swap.dto';
import { SubmitSwapDto } from '@/swaps/dto/submit-swap.dto';
import {
  SwapEntity,
  SwapListEntity,
  SwapQuoteEntity,
  SwapSubmitResultEntity,
} from '@/swaps/entities/swap.entity';
import {
  SWAP_CREATE_RATE_LIMIT,
  SWAP_QUOTE_RATE_LIMIT,
  SWAP_SUBMIT_RATE_LIMIT,
} from '@/swaps/swaps.constants';
import { SwapsService } from '@/swaps/swaps.service';

// URI versioning => /v1/swaps
@ApiTags('swaps')
@Controller({ path: 'swaps', version: '1' })
export class SwapsController {
  constructor(private readonly swaps: SwapsService) {}

  @Post('quote')
  // Prices a path from Horizon. Pure function of the request.
  @AllowPublicKey()
  @RequirePermissions('swaps:read')
  // Persists nothing, but a strict-send path search is one of the most
  // expensive things Horizon serves, and that per-IP budget is shared by every
  // route in this service.
  @RateLimit(SWAP_QUOTE_RATE_LIMIT)
  // POST because the quote parameters are a body, not because anything is
  // created — the route persists nothing, so 200 is the honest status. Nest
  // defaults POST to 201, which is what the committed spec used to record.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Quote a swap (Horizon strict-send path search + fee/slippage); persists nothing',
  })
  @ApiOkResponse({ type: SwapQuoteEntity })
  quote(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: QuoteSwapDto,
  ) {
    return this.swaps.quote(consumer, dto);
  }

  @Post()
  // Builds an unsigned envelope from the request; the wallet signs it.
  @AllowPublicKey()
  @RequirePermissions('swaps:write')
  // A quote's Horizon cost plus a row holding the source account's next
  // sequence number until it expires.
  @RateLimit(SWAP_CREATE_RATE_LIMIT)
  @ApiOperation({
    summary:
      'Create a swap → unsigned XDR + SEP-7 tx URI + QR for the wallet to sign',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional idempotency key. A retry with the same key and the same request ' +
      'returns the existing swap (same id and txHash); the same key with a ' +
      'different request is 409 idempotency_conflict. Takes precedence over ' +
      'body.idempotencyKey.',
    example: 'swap-retry-2026-08-23-001',
  })
  @ApiCreatedResponse({ type: SwapEntity })
  @ApiResponse({
    status: 409,
    content: API_ERROR_BODY_CONTENT,
    description:
      '`idempotency_conflict` — this Idempotency-Key was already used for a ' +
      'different request, or an identical swap was already built without a key ' +
      '(retry with an Idempotency-Key, or wait for the prior swap to settle or ' +
      'expire). `operation_in_flight` — STELLAR_SWAP_SINGLE_INFLIGHT is on and ' +
      'this source account already has a PENDING swap.',
  })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateSwapDto,
    // Read via @Req (not @Headers) so Swagger does not auto-emit a second
    // required `idempotency-key` parameter alongside @ApiHeader.
    @Req() req: Request,
  ) {
    return this.swaps.create(
      consumer,
      dto,
      headerValue(req, 'idempotency-key'),
    );
  }

  @Get()
  @RequirePermissions('swaps:read')
  @ApiOperation({ summary: "List the consumer's swaps" })
  @ApiOkResponse({ type: SwapListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QuerySwapsDto,
  ) {
    return this.swaps.findAll(consumer, query);
  }

  @Get(':id')
  @RequirePermissions('swaps:read')
  @ApiOperation({ summary: 'Get a swap by id' })
  @ApiOkResponse({ type: SwapEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.swaps.findOne(consumer, id);
  }

  @Post(':id/submit')
  // Broadcasts an envelope the caller signed. Nothing about the swap — not even
  // its status — is answered until `signedXdr` parses, hashes to the swap's
  // stored txHash and carries a signature, so reaching another anonymous user's
  // swap takes its UUID *and* its envelope, which only the caller that created
  // it was handed. Whether that signature is valid is the network's call, not
  // this route's: a bad one comes back as a FAILED `tx_bad_auth`, and the
  // resubmit cap and expiry check bound how often that can happen per swap.
  @AllowPublicKey()
  @RequirePermissions('swaps:write')
  // A rejected broadcast costs a Horizon submission and a SWAP_FAILED webhook
  // that no error response refunds, and under the shared public key the client
  // address is the only thing telling anonymous callers apart.
  @RateLimit(SWAP_SUBMIT_RATE_LIMIT)
  // Submit advances an existing swap's status; the swap resource was created by
  // POST /v1/swaps. Nothing new comes into existence here, so 200, not 201.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Relay the signed swap transaction to the network (hash-checked); finalizes status',
  })
  @ApiOkResponse({ type: SwapSubmitResultEntity })
  @ApiResponse({
    status: 400,
    content: API_ERROR_BODY_CONTENT,
    description:
      '`validation_failed` — `signedXdr` is not a transaction envelope, is not ' +
      'the envelope built for this swap, or carries no signatures. ' +
      '`invalid_state_transition` — the swap can no longer be submitted: it is ' +
      "EXPIRED, its transaction's time bounds have passed, or it was already " +
      'resubmitted the maximum number of times after a rejection. Build a new ' +
      'swap.',
  })
  @ApiResponse({
    status: 429,
    content: API_ERROR_BODY_CONTENT,
    description:
      'Rate limited (`rate_limited`), per consumer and client address. Honour ' +
      '`Retry-After`: the window is shorter than the envelope lifetime, so a ' +
      'retry after it still lands in time.',
  })
  submit(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: SubmitSwapDto,
  ) {
    return this.swaps.submit(consumer, id, dto.signedXdr);
  }
}
