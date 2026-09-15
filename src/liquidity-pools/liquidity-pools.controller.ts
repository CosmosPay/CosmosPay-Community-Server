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
import { RequireAnyPermission } from '@/common/decorators/require-permissions.decorator';
import { API_ERROR_BODY_CONTENT } from '@/common/errors/api-error.entity';
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
  // Builds an unsigned envelope.
  @AllowPublicKey()
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  @ApiOperation({
    summary:
      'Build a pool deposit → unsigned XDR + SEP-7 tx URI + QR for the wallet to sign',
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
  @ApiResponse({
    status: 409,
    content: API_ERROR_BODY_CONTENT,
    description:
      '`idempotency_conflict` — this Idempotency-Key was already used for a ' +
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
  // Builds an unsigned envelope.
  @AllowPublicKey()
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  @ApiOperation({
    summary:
      'Build a pool withdrawal (burn shares) → unsigned XDR + SEP-7 tx URI + QR',
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
  @ApiResponse({
    status: 409,
    content: API_ERROR_BODY_CONTENT,
    description:
      '`idempotency_conflict` — this Idempotency-Key was already used for a ' +
      'different request, or an identical withdrawal was already built without ' +
      'a key. `operation_in_flight` — a withdrawal from this pool is already in ' +
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
  // On-chain pool shares for the account in the query, read
  // straight from Horizon — public ledger data, not this consumer's rows.
  @AllowPublicKey()
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({
    summary: "An account's pool share positions with redeemable amounts",
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
  @ApiOperation({ summary: "List the consumer's liquidity pool operations" })
  @ApiOkResponse({ type: LiquidityOperationListEntity })
  findAllOperations(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryLiquidityOperationsDto,
  ) {
    return this.liquidity.findAllOperations(consumer, query);
  }

  @Get('operations/:id')
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({ summary: 'Get a liquidity pool operation by id' })
  @ApiOkResponse({ type: LiquidityOperationEntity })
  findOneOperation(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.liquidity.findOneOperation(consumer, id);
  }

  @Post('operations/:id/submit')
  // Broadcasts a caller-signed envelope.
  @AllowPublicKey()
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  // Submit advances an existing operation's status; the operation was created
  // by POST /v1/liquidity-pools/deposits (or /withdrawals). Nothing new comes
  // into existence here, so 200 — matching swaps' identical submit route.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Relay the signed transaction to the network (hash-checked); finalizes status',
  })
  @ApiOkResponse({ type: LiquiditySubmitResultEntity })
  submit(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: SubmitLiquidityDto,
  ) {
    return this.liquidity.submit(consumer, id, dto.signedXdr);
  }

  @Get()
  // Public on-chain pool data from Horizon.
  @AllowPublicKey()
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({ summary: 'Browse on-chain liquidity pools (Horizon proxy)' })
  @ApiOkResponse({ type: LiquidityPoolListEntity })
  listPools(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryLiquidityPoolsDto,
  ) {
    return this.pools.listPools(consumer, query);
  }

  @Get(':poolId')
  // Public on-chain pool data from Horizon.
  @AllowPublicKey()
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({ summary: 'Get a liquidity pool by id (Horizon proxy)' })
  @ApiOkResponse({ type: LiquidityPoolEntity })
  getPool(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('poolId') poolId: string,
  ) {
    return this.pools.getPool(consumer, poolId);
  }
}
