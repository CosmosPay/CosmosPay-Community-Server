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
import { RequireAnyPermission } from '@/common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
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
import { LiquidityPoolsService } from '@/liquidity-pools/liquidity-pools.service';

// URI versioning => /v1/liquidity-pools. Static segments are declared before
// the `:poolId` catch-all so Express matches them first.
@ApiTags('liquidity-pools')
@Controller({ path: 'liquidity-pools', version: '1' })
export class LiquidityPoolsController {
  constructor(private readonly liquidity: LiquidityPoolsService) {}

  @Post('deposit')
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  @ApiOperation({
    summary:
      'Build a pool deposit → unsigned XDR + SEP-7 tx URI + QR for the wallet to sign',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional idempotency key. Retries with the same key return the existing ' +
      'operation (same id and txHash). Takes precedence over body.idempotencyKey.',
    example: 'lp-deposit-2026-08-23-001',
  })
  @ApiCreatedResponse({ type: LiquidityOperationEntity })
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
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  @ApiOperation({
    summary:
      'Build a pool withdrawal (burn shares) → unsigned XDR + SEP-7 tx URI + QR',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional idempotency key. Retries with the same key return the existing ' +
      'operation (same id and txHash). Takes precedence over body.idempotencyKey.',
    example: 'lp-withdraw-2026-08-23-001',
  })
  @ApiCreatedResponse({ type: LiquidityOperationEntity })
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
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({
    summary: "An account's pool share positions with redeemable amounts",
  })
  @ApiOkResponse({ type: LiquidityPositionListEntity })
  positions(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryLiquidityPositionsDto,
  ) {
    return this.liquidity.positions(consumer, query);
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
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({ summary: 'Browse on-chain liquidity pools (Horizon proxy)' })
  @ApiOkResponse({ type: LiquidityPoolListEntity })
  listPools(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryLiquidityPoolsDto,
  ) {
    return this.liquidity.listPools(consumer, query);
  }

  @Get(':poolId')
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({ summary: 'Get a liquidity pool by id (Horizon proxy)' })
  @ApiOkResponse({ type: LiquidityPoolEntity })
  getPool(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('poolId') poolId: string,
  ) {
    return this.liquidity.getPool(consumer, poolId);
  }
}

function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}
