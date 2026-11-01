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
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequireAnyPermission } from '@/common/decorators/require-permissions.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { headerValue } from '@/common/request-header';
import { DepositLiquidityDto } from '@/liquidity-pools/dto/deposit-liquidity.dto';
import { QueryLiquidityOperationsDto } from '@/liquidity-pools/dto/query-liquidity-operations.dto';
import { QueryLiquidityPoolsDto } from '@/liquidity-pools/dto/query-pools.dto';
import { QueryLiquidityPositionsDto } from '@/liquidity-pools/dto/query-positions.dto';
import { SubmitLiquidityDto } from '@/liquidity-pools/dto/submit-liquidity.dto';
import { WithdrawLiquidityDto } from '@/liquidity-pools/dto/withdraw-liquidity.dto';
import {
  LiquidityOperationEntity,
  LiquidityOperationListEntity,
  LiquidityPoolEntity,
  LiquidityPoolListEntity,
  LiquidityPositionListEntity,
  LiquiditySubmitResultEntity,
} from '@/liquidity-pools/entities/liquidity-pool.entity';
import { LiquidityPoolReaderService } from '@/liquidity-pools/liquidity-pool-reader.service';
import {
  LIQUIDITY_BUILD_RATE_LIMIT,
  LIQUIDITY_SUBMIT_RATE_LIMIT,
} from '@/liquidity-pools/liquidity-pools.constants';
import { LiquidityPoolsService } from '@/liquidity-pools/liquidity-pools.service';

// URI versioning => /v1/liquidity-pools. Static segments are declared before
// the `:poolId` catch-all so Express matches them first.
@ApiTags('liquidity-pools')
@Controller({ path: 'liquidity-pools', version: '1' })
export class LiquidityPoolsController {
  constructor(
    private readonly liquidity: LiquidityPoolsService,
    // Horizon reads (pools, positions) touch no operation row.
    private readonly pools: LiquidityPoolReaderService,
  ) {}

  @Post('deposit')
  @ApiUpstream('Horizon')
  // Builds an unsigned envelope.
  @AllowPublicKey()
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  // Reads the pool and the account from Horizon and holds the account's next
  // sequence number in a row until it expires.
  @RateLimit(LIQUIDITY_BUILD_RATE_LIMIT)
  @ApiOperation({
    summary:
      'Build a pool deposit → unsigned XDR + SEP-7 tx URI + QR for the wallet to sign',
    description:
      "Builds a `liquidityPoolDeposit` on the key's network for `source` to " +
      'sign (preceded by the pool-share trustline when the account has none), ' +
      'stores it as `PENDING` and emits `LIQUIDITY_CREATED`. Leave ' +
      '`maxAmountB` out to match the pool’s current ratio (an empty pool ' +
      'needs both amounts, which set its price); the price bounds bracket ' +
      'the pool price by `slippageBps` (default 50, cap 500 unless ' +
      'configured). Deposits pay no plan ' +
      'commission; a `merchantFee` is paid from each asset, and `source` ' +
      'must trust both assets and afford the amounts plus its reserve ' +
      '(`trustline_missing`, `insufficient_balance`). An `Idempotency-Key` ' +
      '(header or body) makes a retry return the same operation.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional idempotency key. A retry with the same key and the same request ' +
      'returns the existing operation (same id and txHash); the same key with a ' +
      'different request is 409 idempotency_conflict. Takes precedence over ' +
      'body.idempotencyKey.',
    example: 'lp-deposit-2026-08-23-001',
  })
  @ApiCreatedResponse({ type: LiquidityOperationEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidAmount,
      ApiErrorCode.TrustlineMissing,
      ApiErrorCode.InsufficientBalance,
    ],
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.IdempotencyConflict],
    description:
      '`idempotency_conflict`: this Idempotency-Key was already used for a ' +
      'different request, or an identical deposit was already built without a ' +
      'key (retry with an Idempotency-Key, or wait for the prior operation to ' +
      'settle or expire).',
  })
  deposit(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: DepositLiquidityDto,
    // Read via @Req (not @Headers) so Swagger does not auto-emit a second
    // required `idempotency-key` parameter alongside @ApiHeader.
    @Req() req: Request,
  ) {
    return this.liquidity.deposit(
      consumer,
      dto,
      headerValue(req, 'idempotency-key'),
    );
  }

  @Post('withdraw')
  @ApiUpstream('Horizon')
  // Builds an unsigned envelope.
  @AllowPublicKey()
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  // One budget with deposit — the two directions of one flow.
  @RateLimit(LIQUIDITY_BUILD_RATE_LIMIT)
  @ApiOperation({
    summary:
      'Build a pool withdrawal (burn shares) → unsigned XDR + SEP-7 tx URI + QR',
    description:
      "Builds a `liquidityPoolWithdraw` of `shares` from `poolId` on the key's " +
      'network for `source` to sign, with minimum amounts of each reserve ' +
      'set from the current reserves less `slippageBps`, stores it as ' +
      '`PENDING` and emits `LIQUIDITY_CREATED`. The plan commission is ' +
      'charged only on the gain over the cost basis of shares deposited ' +
      'through this service, out of the withdrawn reserves; a `merchantFee` ' +
      'is a share of the minimum amounts. A withdrawal from the same pool ' +
      'that may already be on-chain blocks another one for that account ' +
      '(`operation_in_flight`); an `Idempotency-Key` (header or body) makes ' +
      'a retry return the same operation.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional idempotency key. A retry with the same key and the same request ' +
      'returns the existing operation (same id and txHash); the same key with a ' +
      'different request is 409 idempotency_conflict. Takes precedence over ' +
      'body.idempotencyKey.',
    example: 'lp-withdraw-2026-08-23-001',
  })
  @ApiCreatedResponse({ type: LiquidityOperationEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.ValidationFailed,
      ApiErrorCode.InvalidAmount,
      ApiErrorCode.InsufficientBalance,
      // A merchant fee's wallet that cannot receive one of the reserves.
      ApiErrorCode.TrustlineMissing,
    ],
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.IdempotencyConflict, ApiErrorCode.OperationInFlight],
    description:
      '`idempotency_conflict`: this Idempotency-Key was already used for a ' +
      'different request, or an identical withdrawal was already built without ' +
      'a key. `operation_in_flight`: a withdrawal from this pool is already in ' +
      'flight for this account; wait for it to settle or expire.',
  })
  withdraw(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: WithdrawLiquidityDto,
    @Req() req: Request,
  ) {
    return this.liquidity.withdraw(
      consumer,
      dto,
      headerValue(req, 'idempotency-key'),
    );
  }

  @Get('positions')
  // Read live off the account's balances.
  @ApiUpstream('Horizon')
  // On-chain pool shares for the account in the query, read
  // straight from Horizon — public ledger data, not this consumer's rows.
  @AllowPublicKey()
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({
    summary: "An account's pool share positions with redeemable amounts",
    description:
      "Reads `account`'s pool-share trustlines from Horizon on the key's " +
      'network and, per pool, its shares, its share of the pool in basis ' +
      'points, the reserves and what those shares redeem now. Ledger data, ' +
      "not this consumer's rows: any account can be read, and nothing is " +
      'stored.',
  })
  @ApiOkResponse({ type: LiquidityPositionListEntity })
  positions(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryLiquidityPositionsDto,
  ) {
    return this.pools.positions(consumer, query);
  }

  @Get('operations')
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({
    summary: "List the consumer's liquidity pool operations",
    description:
      'The deposits and withdrawals built through this service, newest ' +
      'first, optionally filtered by `kind` and `status`. Paginated with ' +
      '`take` (default 20, max 100) and `skip`; the answer is ' +
      "`{ data, total, take, skip }`. Only operations on the key's network " +
      'are listed (a `prod` key sees mainnet, a `dev` key testnet).',
  })
  @ApiOkResponse({ type: LiquidityOperationListEntity })
  findAllOperations(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryLiquidityOperationsDto,
  ) {
    return this.liquidity.findAllOperations(consumer, query);
  }

  @Get('operations/:id')
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({
    summary: 'Get a liquidity pool operation by id',
    description:
      'One deposit or withdrawal this consumer built: its unsigned XDR, ' +
      'SEP-7 `uri` and QR, its status, and the commission and merchant fee ' +
      "it carries. Answered from this service's own table, which submit and " +
      'the settlement observer keep current.',
  })
  @ApiOkResponse({ type: LiquidityOperationEntity })
  findOneOperation(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.liquidity.findOneOperation(consumer, id);
  }

  @Post('operations/:id/submit')
  @ApiUpstream('Horizon')
  // Broadcasts a caller-signed envelope. Nothing about the operation — not even
  // its status — is answered until `signedXdr` parses, hashes to its stored
  // txHash and carries a signature, so reaching another anonymous user's
  // operation takes its UUID *and* its envelope, which only the caller that
  // built it was handed. Whether the signature is valid is the network's call:
  // a bad one comes back as a FAILED `tx_bad_auth`, bounded per operation by the
  // resubmit cap and the expiry check.
  @AllowPublicKey()
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  // A rejected broadcast costs a Horizon submission and a LIQUIDITY_FAILED
  // webhook that no error response refunds, and under the shared public key the
  // client address is the only thing telling anonymous callers apart.
  @RateLimit(LIQUIDITY_SUBMIT_RATE_LIMIT)
  // Submit advances an existing operation's status; the operation was created
  // by POST /v1/liquidity-pools/deposit (or /withdraw). Nothing new comes into
  // existence here, so 200 — matching swaps' identical submit route.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Relay the signed transaction to the network (hash-checked); finalizes status',
    description:
      "`signedXdr` must hash to the operation's stored transaction and carry " +
      'a signature, checked before anything about the operation is answered. ' +
      'It is broadcast through Horizon and the answer is `SUCCEEDED` or ' +
      '`submitted: false` with the result codes (a `FAILED` operation can be ' +
      'resubmitted up to 3 times while its envelope is valid); an ' +
      'unreachable Horizon is a 503 that leaves it resubmittable. Emits ' +
      '`LIQUIDITY_SUBMITTED`, then `LIQUIDITY_SUCCEEDED` or ' +
      '`LIQUIDITY_FAILED`, and a settled deposit records the cost basis the ' +
      'withdrawal commission is charged against.',
  })
  @ApiOkResponse({ type: LiquiditySubmitResultEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.InvalidStateTransition],
    description:
      '`validation_failed`: `signedXdr` is not a transaction envelope, is not ' +
      'the envelope built for this operation, or carries no signatures. ' +
      '`invalid_state_transition`: the operation can no longer be submitted, because ' +
      "it is EXPIRED, its transaction's time bounds have passed, or it was " +
      'already resubmitted the maximum number of times after a rejection. Build ' +
      'a new deposit or withdrawal.',
  })
  @ApiErrorResponse({
    status: 429,
    codes: [ApiErrorCode.RateLimited],
    description:
      'Rate limited (`rate_limited`), per consumer and client address, in a ' +
      'bucket separate from the swaps submit route. Honour `Retry-After`: the ' +
      'window is shorter than the envelope lifetime, so a retry after it still ' +
      'lands in time.',
  })
  submit(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: SubmitLiquidityDto,
  ) {
    return this.liquidity.submit(consumer, id, dto.signedXdr);
  }

  @Get()
  // The pool list is Horizon's, not a table of ours.
  @ApiUpstream('Horizon')
  // Public on-chain pool data from Horizon.
  @AllowPublicKey()
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({
    summary: 'Browse on-chain liquidity pools (Horizon proxy)',
    description:
      "Horizon's pool list on the key's network, in descending order, " +
      'optionally narrowed to pools holding one or two assets ' +
      '(`assetACode`/`assetAIssuer`, `assetBCode`/`assetBIssuer`) or to ' +
      'those an `account` holds shares in. Paged by Horizon cursor, not ' +
      '`take`/`skip`: `limit` per page (default 20, max 100), and the ' +
      "answer's `cursor` fetches the next page (null when the page is not " +
      'full). Nothing is stored.',
  })
  @ApiOkResponse({ type: LiquidityPoolListEntity })
  listPools(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryLiquidityPoolsDto,
  ) {
    return this.pools.listPools(consumer, query);
  }

  @Get(':poolId')
  @ApiUpstream('Horizon')
  // Public on-chain pool data from Horizon.
  @AllowPublicKey()
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({
    summary: 'Get a liquidity pool by id (Horizon proxy)',
    description:
      "One pool read from Horizon on the key's network: its fee, trustline " +
      'count, total shares and reserves. `poolId` is the 64-character ' +
      'lowercase hex pool id; any other shape is `validation_failed`, and a ' +
      'pool that does not exist on that network is a 404.',
  })
  @ApiOkResponse({ type: LiquidityPoolEntity })
  getPool(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('poolId') poolId: string,
  ) {
    return this.pools.getPool(consumer, poolId);
  }
}
