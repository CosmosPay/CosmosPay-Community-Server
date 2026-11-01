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
import { ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { RECORD_TOKEN_HEADER } from '@/common/public-record-token.constants';
import { headerValue } from '@/common/request-header';
import {
  CROSS_CHAIN_CREATE_RATE_LIMIT,
  CROSS_CHAIN_DEPOSIT_RATE_LIMIT,
  CROSS_CHAIN_QUOTE_RATE_LIMIT,
} from '@/cross-chain-swaps/cross-chain-swaps.constants';
import { CrossChainSwapsService } from '@/cross-chain-swaps/cross-chain-swaps.service';
import { CreateCrossChainSwapDto } from '@/cross-chain-swaps/dto/create-cross-chain-swap.dto';
import { QueryCrossChainSwapsDto } from '@/cross-chain-swaps/dto/query-cross-chain-swaps.dto';
import { QuoteCrossChainSwapDto } from '@/cross-chain-swaps/dto/quote-cross-chain-swap.dto';
import { SubmitDepositDto } from '@/cross-chain-swaps/dto/submit-deposit.dto';
import {
  CrossChainAssetListEntity,
  CrossChainQuoteEntity,
  CrossChainSwapCreatedEntity,
  CrossChainSwapEntity,
  CrossChainSwapListEntity,
} from '@/cross-chain-swaps/entities/cross-chain-swap.entity';

// URI versioning => /v1/cross-chain-swaps
@ApiTags('cross-chain-swaps')
@Controller({ path: 'cross-chain-swaps', version: '1' })
export class CrossChainSwapsController {
  constructor(private readonly swaps: CrossChainSwapsService) {}

  @Get('assets')
  // The token list, from 1Click (cached a few minutes).
  @ApiUpstream('NEAR Intents')
  // A catalogue, the same for every caller.
  @AllowPublicKey()
  @RequirePermissions('swaps:read')
  @ApiOperation({
    summary:
      'List the assets NEAR Intents can swap, with an indicative USD price',
    description:
      'Only what NEAR Intents still trades. A token it tags deprecated is left ' +
      'out, and so is one it lists with no price, because it answers no quote ' +
      'for such a token.',
  })
  @ApiOkResponse({ type: CrossChainAssetListEntity })
  assets() {
    return this.swaps.assets();
  }

  @Post('quote')
  @ApiUpstream('NEAR Intents')
  // A pure function of the request; persists nothing.
  @AllowPublicKey()
  @RequirePermissions('swaps:read')
  // A solver auction at 1Click on the deployment's one partner key.
  @RateLimit(CROSS_CHAIN_QUOTE_RATE_LIMIT)
  // Nothing is created: 200, not Nest's default 201 for a POST.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Quote a cross-chain swap through NEAR Intents (price, commission, minimum); persists nothing',
    description:
      'A dry NEAR Intents quote for `amount` of `originAsset` on ' +
      '`originChain` into `destinationAsset` on `destinationChain`: the ' +
      'expected and minimum output, the plan commission (`fee`, in the ' +
      'origin asset), any `merchantFee` (its wallet a NEAR account) and a ' +
      "time estimate. Prices are mainnet's for every key, a `dev` key " +
      'included. A pair on one chain among Stellar, Solana and Monad is ' +
      '`validation_failed`: those go through `POST /v1/swaps`. ' +
      '`slippageBps` defaults to 100 and is capped at 500, unless the ' +
      'deployment configures other values.',
  })
  @ApiOkResponse({ type: CrossChainQuoteEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidAmount,
      ApiErrorCode.SlippageExceeded,
      ApiErrorCode.AssetUnsupported,
      ApiErrorCode.ProviderError,
    ],
    description:
      '`provider_error`: NEAR Intents refused the quote (an amount below its ' +
      'minimum, a route it cannot fill); `message` carries its reason.',
  })
  @ApiErrorResponse({
    status: 503,
    codes: [ApiErrorCode.ProviderUnavailable, ApiErrorCode.Misconfigured],
    description:
      '`provider_unavailable`: NEAR Intents is down or rate limiting this ' +
      'service; retry. `misconfigured`: the plan charges a commission and ' +
      'NEAR_INTENTS_FEE_RECIPIENT is not set, or NEAR Intents rejected ' +
      'NEAR_INTENTS_API_KEY.',
  })
  quote(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: QuoteCrossChainSwapDto,
  ) {
    return this.swaps.quote(consumer, dto);
  }

  @Post()
  // A live quote: 1Click derives the deposit address. A Stellar recipient's
  // trustline is checked on Horizon.
  @ApiUpstream('NEAR Intents', 'Horizon')
  // The anonymous wallet flow: the payer builds, deposits and watches.
  @AllowPublicKey()
  @RequirePermissions('swaps:write')
  @RateLimit(CROSS_CHAIN_CREATE_RATE_LIMIT)
  @ApiOperation({
    summary: 'Create a cross-chain swap: a NEAR Intents deposit address to pay',
    description:
      'Asks NEAR Intents for a live quote with a deposit address for this ' +
      'swap alone, stores it as `AWAITING_DEPOSIT` and emits ' +
      '`CROSS_CHAIN_SWAP_CREATED`. The payer sends `amountIn` to ' +
      '`depositAddress` (with `depositMemo` when set) before `expiresAt`; ' +
      "`depositUri` is a wallet link in the origin chain's standard (SEP-7, " +
      'Solana Pay, EIP-681, BIP-21, TON, CIP-13) with a QR, or null where ' +
      'the chain has none. NEAR Intents pays `recipient` or refunds ' +
      '`refundTo`, and a Stellar `recipient` must already trust the asset. ' +
      'Mainnet only; an `Idempotency-Key` (header or body) makes a retry ' +
      'return the same swap and address.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional idempotency key. A retry with the same key and the same request ' +
      'returns the existing swap (same deposit address); the same key with a ' +
      'different request is 409 idempotency_conflict. Takes precedence over ' +
      'body.idempotencyKey.',
    example: 'xswap-retry-2026-10-02-001',
  })
  @ApiCreatedResponse({
    type: CrossChainSwapCreatedEntity,
    description:
      'The swap. With the shared public key it carries `publicToken`: send it ' +
      'as `X-Record-Token` to read the swap or report its deposit.',
  })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidAmount,
      ApiErrorCode.SlippageExceeded,
      ApiErrorCode.AssetUnsupported,
      ApiErrorCode.NetworkUnsupported,
      ApiErrorCode.TrustlineMissing,
      ApiErrorCode.ProviderError,
    ],
    description:
      '`network_unsupported`: a dev (testnet) key, and NEAR Intents settles on ' +
      'mainnet only. `trustline_missing`: a Stellar recipient does not trust ' +
      'the destination asset, and only that account can add the trustline. ' +
      '`provider_error`: NEAR Intents refused the quote.',
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.IdempotencyConflict],
    description:
      'This Idempotency-Key was already used for a different cross-chain swap request.',
  })
  @ApiErrorResponse({
    status: 503,
    codes: [ApiErrorCode.ProviderUnavailable, ApiErrorCode.Misconfigured],
    description:
      '`provider_unavailable`: NEAR Intents is down or rate limiting this ' +
      'service; retry. `misconfigured`: the plan charges a commission and ' +
      'NEAR_INTENTS_FEE_RECIPIENT is not set, or NEAR Intents rejected ' +
      'NEAR_INTENTS_API_KEY.',
  })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateCrossChainSwapDto,
    // Read via @Req (not @Headers) so Swagger does not emit a second
    // `idempotency-key` parameter beside @ApiHeader.
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
  @ApiOperation({
    summary: "List the consumer's cross-chain swaps",
    description:
      "Answered from this service's own table, which the observer keeps " +
      'current from NEAR Intents: newest first, optionally filtered by ' +
      '`status`. Paginated with `take` (default 20, max 100) and `skip`; ' +
      'the answer is `{ data, total, take, skip }`. Cross-chain swaps run ' +
      'on mainnet only, so a `dev` key lists none.',
  })
  @ApiOkResponse({ type: CrossChainSwapListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryCrossChainSwapsDto,
  ) {
    return this.swaps.findAll(consumer, query);
  }

  @Get(':id')
  // Reads this service's own mirror; the observer keeps it current. A public
  // swap follows its own status with its record token (`X-Record-Token`); the
  // list stays closed to the public key.
  @AllowPublicKey()
  @RequirePermissions('swaps:read')
  @ApiRecordTokenHeader()
  @ApiOperation({
    summary: 'Get a cross-chain swap by id',
    description:
      'The shared public key may call it, so a swap made without an account ' +
      'can follow its own status, but only with the swap’s `publicToken` in ' +
      '`X-Record-Token`: without it, or with another swap’s, the answer is ' +
      '404. Every other key reads its own swaps as before. Listing swaps ' +
      'stays closed to the public key.',
  })
  @ApiOkResponse({ type: CrossChainSwapEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.swaps.findOne(
      consumer,
      id,
      headerValue(req, RECORD_TOKEN_HEADER),
    );
  }

  @Post(':id/deposit')
  @ApiUpstream('NEAR Intents')
  // The wallet that just paid reports its transaction. Reaching another
  // anonymous caller's swap takes its id, and all a hash can do is point
  // 1Click at a transaction it verifies on-chain itself.
  @AllowPublicKey()
  @RequirePermissions('swaps:write')
  // With the shared public key, the swap's record token: a wrong one is a
  // 404, a missing one is still accepted on this legacy route (logged) until
  // PUBLIC_RECORD_TOKEN_REQUIRED_ON_LEGACY is on.
  @ApiRecordTokenHeader('legacy')
  @RateLimit(CROSS_CHAIN_DEPOSIT_RATE_LIMIT)
  // Advances an existing swap; nothing new comes into existence.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Report the deposit transaction to NEAR Intents so the swap starts without waiting for its indexer',
    description:
      '`txHash` must have the shape of a transaction id on the origin ' +
      'chain; NEAR Intents then reads that chain itself and credits only ' +
      'what really arrived at `depositAddress`. The swap records ' +
      '`depositTxHash`, moves to the status NEAR Intents reports and emits ' +
      'the matching `CROSS_CHAIN_SWAP_*` event when that status changes. ' +
      'Reporting is optional, since the observer follows the swap either ' +
      "way; with the shared public key, send the swap's `publicToken` in " +
      '`X-Record-Token`.',
  })
  @ApiOkResponse({ type: CrossChainSwapEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidStateTransition,
      ApiErrorCode.ProviderError,
    ],
    description:
      '`validation_failed`: txHash is not a transaction id of the origin ' +
      'chain. `invalid_state_transition`: the swap already SUCCEEDED, was ' +
      'REFUNDED or FAILED. `provider_error`: NEAR Intents refused the hash.',
  })
  submitDeposit(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: SubmitDepositDto,
    @Req() req: Request,
  ) {
    return this.swaps.submitDeposit(
      consumer,
      id,
      dto.txHash,
      headerValue(req, RECORD_TOKEN_HEADER),
    );
  }
}
