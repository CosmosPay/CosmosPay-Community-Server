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
  type Type,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { type Chain, DEFAULT_CHAIN } from '@/chains/chains.constants';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiRecordTokenHeader } from '@/common/decorators/api-record-token.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import {
  LEGACY_RECORD_TOKEN_ROUTES,
  RECORD_TOKEN_HEADER,
} from '@/common/public-record-token.constants';
import { headerValue } from '@/common/request-header';
import { ChainSwapsService } from '@/swaps/chain-swaps.service';
import { CreateSwapDto } from '@/swaps/dto/create-swap.dto';
import { QuerySwapsDto } from '@/swaps/dto/query-swaps.dto';
import { QuoteSwapDto } from '@/swaps/dto/quote-swap.dto';
import { SubmitSwapDto } from '@/swaps/dto/submit-swap.dto';
import {
  ChainSwapCreatedEntity,
  ChainSwapEntity,
  ChainSwapListEntity,
  ChainSwapSubmitResultEntity,
  SwapCreatedEntity,
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

/** A body that is one of two shapes: Stellar's, or Solana/Monad's. */
const eitherOf = (stellar: Type<unknown>, chain: Type<unknown>) => ({
  oneOf: [{ $ref: getSchemaPath(stellar) }, { $ref: getSchemaPath(chain) }],
});

/** No `chain` means Stellar, exactly as before the field existed. */
const isStellar = (chain: Chain | undefined): chain is 'stellar' | undefined =>
  (chain ?? DEFAULT_CHAIN) === 'stellar';

// URI versioning => /v1/swaps
//
// Same-chain swaps on every chain. No `chain` (or `stellar`) is the Stellar DEX,
// byte for byte what this route served before; `solana` goes through Jupiter and
// `monad` through Kuru Flow (ChainSwapsService). Swaps between chains are
// /v1/cross-chain-swaps.
@ApiTags('swaps')
@ApiExtraModels(
  ChainSwapCreatedEntity,
  ChainSwapEntity,
  ChainSwapListEntity,
  ChainSwapSubmitResultEntity,
  SwapCreatedEntity,
  SwapEntity,
  SwapListEntity,
  SwapSubmitResultEntity,
)
@Controller({ path: 'swaps', version: '1' })
export class SwapsController {
  constructor(
    private readonly swaps: SwapsService,
    private readonly chainSwaps: ChainSwapsService,
  ) {}

  @Post('quote')
  // Stellar: a strict-send path search at Horizon. Solana: Jupiter, and the
  // RPC for a mint's decimals. Monad: Kuru Flow, and the RPC.
  @ApiUpstream('Horizon', 'Jupiter', 'Kuru Flow', 'Solana', 'Monad')
  // Prices a route. Pure function of the request.
  @AllowPublicKey()
  @RequirePermissions('swaps:read')
  // Persists nothing, but a strict-send path search is one of the most
  // expensive things Horizon serves, and that per-IP budget is shared by every
  // route in this service; the aggregators' budgets are the deployment's too.
  @RateLimit(SWAP_QUOTE_RATE_LIMIT)
  // POST because the quote parameters are a body, not because anything is
  // created — the route persists nothing, so 200 is the honest status. Nest
  // defaults POST to 201, which is what the committed spec used to record.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Quote a swap on one chain; persists nothing',
    description:
      "Prices `amount` of the source asset on the chain's own venue: the " +
      "Stellar DEX (a Horizon strict-send path search on the key's network) " +
      'when `chain` is omitted or `stellar`, Jupiter for `solana` and Kuru ' +
      'Flow for `monad`, both mainnet only. The answer carries the plan ' +
      'commission (`fee`: taken from the source amount on Stellar, from the ' +
      'output on Solana and Monad), any `merchantFee`, the estimated output ' +
      'and the minimum after slippage. `slippageBps` defaults to 50 and a ' +
      'value above the cap (500) is `slippage_exceeded`, unless the ' +
      'deployment configures other values.',
  })
  @ApiOkResponse({ type: SwapQuoteEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidAmount,
      ApiErrorCode.SlippageExceeded,
      ApiErrorCode.NoPathFound,
      ApiErrorCode.AssetUnsupported,
      ApiErrorCode.NetworkUnsupported,
      ApiErrorCode.ProviderError,
      ApiErrorCode.MerchantFeeUnsupported,
    ],
    description:
      '`network_unsupported`: `chain: solana | monad` with a dev (testnet) ' +
      'key: Jupiter and Kuru Flow run on mainnet only. `asset_unsupported`: ' +
      'not an SPL mint / ERC-20 on that chain. `provider_error`: the ' +
      'aggregator found no route or refused the amount. ' +
      '`merchant_fee_unsupported`: a `merchantFee` on a Monad swap where no ' +
      'merchant fee router is configured (KURU_MERCHANT_FEE_ROUTER).',
  })
  @ApiErrorResponse({
    status: 503,
    codes: [ApiErrorCode.ProviderUnavailable, ApiErrorCode.Misconfigured],
    description:
      '`misconfigured`: the plan charges a commission and the chain has no ' +
      'fee wallet configured (STELLAR_SWAP_FEE_WALLET, SOLANA_SWAP_FEE_WALLET, ' +
      'MONAD_SWAP_FEE_WALLET), or KURU_MERCHANT_FEE_ROUTER is not a ' +
      'MerchantFeeSwapRouter.',
  })
  quote(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: QuoteSwapDto,
  ) {
    return isStellar(dto.chain)
      ? this.swaps.quote(consumer, dto)
      : this.chainSwaps.quote(consumer, dto);
  }

  @Post()
  // Stellar: prices and loads the source account from Horizon. Solana /
  // Monad: the aggregator builds; the RPC answers decimals and allowances.
  @ApiUpstream('Horizon', 'Jupiter', 'Kuru Flow', 'Solana', 'Monad')
  // Builds an unsigned transaction from the request; the wallet signs it.
  @AllowPublicKey()
  @RequirePermissions('swaps:write')
  // A quote's upstream cost plus a row, which on Stellar holds the source
  // account's next sequence number until it expires.
  @RateLimit(SWAP_CREATE_RATE_LIMIT)
  @ApiOperation({
    summary: 'Create a swap: the unsigned transaction to sign',
    description:
      'Prices the swap as the quote does, builds the transaction `source` ' +
      'signs, stores it as `PENDING` and emits `SWAP_CREATED`. Stellar: the ' +
      'XDR with a SEP-7 `uri` and QR, valid for the network timeout (300 s ' +
      'by default); when the swap pays `source` itself (no `destination`, or ' +
      'the same account) and it does not trust the bought asset yet, the ' +
      'transaction adds that trustline first. Solana and Monad (mainnet only): the aggregator’s ' +
      'transaction, valid for one minute on Solana and two on Monad, where ' +
      'an ERC-20 sale may also carry an `approval` to send first. Send the ' +
      'signed transaction to `POST /v1/swaps/{id}/submit`; an ' +
      '`Idempotency-Key` (header or body) makes a retry return the same swap.',
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
  @ApiCreatedResponse({
    description:
      'A Stellar swap (no `chain`, or `stellar`), or a Solana / Monad swap. ' +
      'With the shared public key it carries `publicToken`: send it as ' +
      '`X-Record-Token` to read the swap or submit it.',
    schema: eitherOf(SwapCreatedEntity, ChainSwapCreatedEntity),
  })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidAmount,
      ApiErrorCode.SlippageExceeded,
      ApiErrorCode.NoPathFound,
      ApiErrorCode.TrustlineMissing,
      ApiErrorCode.InsufficientBalance,
      ApiErrorCode.AssetUnsupported,
      ApiErrorCode.NetworkUnsupported,
      ApiErrorCode.ProviderError,
      ApiErrorCode.MerchantFeeUnsupported,
    ],
    description:
      'Stellar: `trustline_missing` (the destination is another account that ' +
      'does not trust the bought asset, and only it can add the trustline; a ' +
      'source that receives the swap gets the trustline in the same ' +
      'transaction instead), `insufficient_balance` (the source cannot keep ' +
      'the 0.5 XLM reserve that trustline locks, after what the transaction ' +
      'sends and its fee), `no_path_found`. ' +
      'Solana / Monad: `network_unsupported` (a dev key), `asset_unsupported`, ' +
      '`provider_error` (no route, or the aggregator simulated a failure, ' +
      'usually a wallet that cannot cover the amount plus fees). ' +
      'Monad: `merchant_fee_unsupported` (a `merchantFee` and no merchant ' +
      'fee router configured, KURU_MERCHANT_FEE_ROUTER).',
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.IdempotencyConflict, ApiErrorCode.OperationInFlight],
    description:
      '`idempotency_conflict`: this Idempotency-Key was already used for a ' +
      'different request, or an identical swap was already built without a key ' +
      '(retry with an Idempotency-Key, or wait for the prior swap to settle or ' +
      'expire). `operation_in_flight`: STELLAR_SWAP_SINGLE_INFLIGHT is on and ' +
      'this source account already has a PENDING swap.',
  })
  @ApiErrorResponse({
    status: 503,
    codes: [ApiErrorCode.ProviderUnavailable, ApiErrorCode.Misconfigured],
    description:
      '`misconfigured`: the plan charges a commission and the chain has no ' +
      'fee wallet (or, on Solana, the fee wallet has no token account for the ' +
      'output mint yet), or, for a Monad swap with a merchant fee, ' +
      'KURU_MERCHANT_FEE_ROUTER is not a MerchantFeeSwapRouter or Kuru Flow ' +
      'routes through another aggregator than the one it was deployed for.',
  })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateSwapDto,
    // Read via @Req (not @Headers) so Swagger does not auto-emit a second
    // required `idempotency-key` parameter alongside @ApiHeader.
    @Req() req: Request,
  ) {
    const key = headerValue(req, 'idempotency-key');
    return isStellar(dto.chain)
      ? this.swaps.create(consumer, dto, key)
      : this.chainSwaps.create(consumer, dto, key);
  }

  @Get()
  @RequirePermissions('swaps:read')
  @ApiOperation({
    summary: "List the consumer's swaps on one chain",
    description:
      'Stellar swaps when `chain` is omitted, otherwise those of the chain ' +
      'named, newest first and optionally filtered by `status`. Paginated ' +
      'with `take` (default 20, max 100) and `skip`; the answer is ' +
      "`{ data, total, take, skip }`. Only swaps on the key's network are " +
      'listed (a `prod` key sees mainnet, a `dev` key testnet), and Solana ' +
      'and Monad swaps are mainnet only, so a `dev` key lists none of them.',
  })
  @ApiOkResponse({
    description: 'Stellar swaps (no `chain`), or those of the chain named.',
    schema: eitherOf(SwapListEntity, ChainSwapListEntity),
  })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QuerySwapsDto,
  ) {
    return isStellar(query.chain)
      ? this.swaps.findAll(consumer, query)
      : this.chainSwaps.findAll(consumer, query.chain, query);
  }

  @Get(':id')
  // A public swap follows its own status. The shared public key is every
  // anonymous caller and an id is not a secret, so that key also needs the
  // swap's record token (`X-Record-Token`, handed out by create); without it
  // the answer is the 404 of a missing swap. The list stays closed to it.
  @AllowPublicKey()
  @RequirePermissions('swaps:read')
  @ApiRecordTokenHeader()
  @ApiOperation({
    summary: 'Get a swap by id, on any chain',
    description:
      'The shared public key may call it, so a swap made without an account ' +
      'can follow its own status, but only with the swap’s `publicToken` in ' +
      '`X-Record-Token`: without it, or with another swap’s, the answer is ' +
      '404. Every other key reads its own swaps as before. Listing swaps ' +
      'stays closed to the public key.',
  })
  @ApiOkResponse({ schema: eitherOf(SwapEntity, ChainSwapEntity) })
  async findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const token = headerValue(req, RECORD_TOKEN_HEADER);
    // Ids are unique across both tables. A miss in the Solana/Monad table
    // falls through to Stellar's, whose 404 is the one a miss always answered.
    const chainSwap = await this.chainSwaps.findOwned(consumer, id, token);
    return chainSwap
      ? this.chainSwaps.present(chainSwap)
      : this.swaps.findOne(consumer, id, token);
  }

  @Post(':id/submit')
  // Broadcasts through Horizon, or this service's Solana / Monad RPC. The two
  // reads above answer from this service's own tables and never touch them.
  @ApiUpstream('Horizon', 'Solana', 'Monad')
  // Broadcasts a transaction the caller signed. Nothing about the swap — not
  // even its status — is answered until the signed transaction is the one
  // built for it (its hash on Stellar, its message on Solana, its call on
  // Monad) and carries its source's signature, so reaching another anonymous
  // user's swap takes its id *and* its transaction, which only the caller that
  // created it was handed. On Stellar whether that signature is valid is the
  // network's call: a bad one comes back as a FAILED `tx_bad_auth`, and the
  // resubmit cap and expiry check bound how often that can happen per swap.
  @AllowPublicKey()
  @RequirePermissions('swaps:write')
  // With the shared public key, the swap's record token: a wrong one is a
  // 404, a missing one is still accepted on this legacy route (logged) until
  // PUBLIC_RECORD_TOKEN_REQUIRED_ON_LEGACY is on. The envelope check below is
  // what keeps someone else's submit out meanwhile.
  @ApiRecordTokenHeader('legacy')
  // A rejected broadcast costs a submission and possibly a webhook that no
  // error response refunds, and under the shared public key the client address
  // is the only thing telling anonymous callers apart.
  @RateLimit(SWAP_SUBMIT_RATE_LIMIT)
  // Submit advances an existing swap's status; the swap resource was created by
  // POST /v1/swaps. Nothing new comes into existence here, so 200, not 201.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Relay the signed swap transaction to its network (checked against the one built); finalizes status',
    description:
      '`signedXdr` (Stellar) or `signedTransaction` (Solana, Monad) must be ' +
      "the transaction built for this swap and carry its source's signature, " +
      'checked before anything about the swap is answered. Stellar: ' +
      'broadcast through Horizon, the answer is `SUCCEEDED` or ' +
      '`submitted: false` with the result codes (a `FAILED` swap can be ' +
      'resubmitted up to 3 times while its envelope is valid). Solana and ' +
      "Monad: broadcast through this service's RPC, the swap is `SUBMITTED` " +
      'until the observer sees it settle. Emits `SWAP_SUBMITTED`, then ' +
      '`SWAP_SUCCEEDED` or `SWAP_FAILED`; with the shared public key, send ' +
      "the swap's `publicToken` in `X-Record-Token`.",
  })
  @ApiOkResponse({
    schema: eitherOf(SwapSubmitResultEntity, ChainSwapSubmitResultEntity),
  })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidStateTransition,
      ApiErrorCode.TransactionRejected,
    ],
    description:
      '`validation_failed`: `signedXdr` (Stellar) / `signedTransaction` ' +
      '(Solana, Monad) is not a transaction, is not the one built for this ' +
      'swap, or carries no signature of its source. `transaction_rejected`: ' +
      'the Solana or Monad node refused the broadcast; the swap stays PENDING. ' +
      '`invalid_state_transition`: the swap can no longer be submitted, because it is ' +
      "EXPIRED, its transaction's validity window has passed, or it was already " +
      'resubmitted the maximum number of times after a rejection. Build a new ' +
      'swap.',
  })
  @ApiErrorResponse({
    status: 429,
    codes: [ApiErrorCode.RateLimited],
    description:
      'Rate limited (`rate_limited`), per consumer and client address. Honour ' +
      '`Retry-After`: the window is shorter than the envelope lifetime, so a ' +
      'retry after it still lands in time.',
  })
  async submit(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: SubmitSwapDto,
    @Req() req: Request,
  ) {
    const token = headerValue(req, RECORD_TOKEN_HEADER);
    const chainSwap = await this.chainSwaps.findOwned(
      consumer,
      id,
      token,
      LEGACY_RECORD_TOKEN_ROUTES.swapSubmit,
    );
    if (chainSwap) {
      return this.chainSwaps.submit(consumer, chainSwap, dto.signedTransaction);
    }
    // The DTO requires signedXdr unless signedTransaction was sent, and a
    // Stellar swap needs signedXdr either way. Said before looking it up.
    if (dto.signedXdr === undefined) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'signedXdr is required for a Stellar swap',
      );
    }
    return this.swaps.submit(consumer, id, dto.signedXdr, token);
  }
}
