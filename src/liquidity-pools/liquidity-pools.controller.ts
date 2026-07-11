import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '../common/decorators/current-consumer.decorator';
import { RequireAnyPermission } from '../common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { DepositLiquidityDto } from './dto/deposit-liquidity.dto';
import { QueryLiquidityOperationsDto } from './dto/query-liquidity-operations.dto';
import { QueryLiquidityPoolsDto } from './dto/query-pools.dto';
import { QueryLiquidityPositionsDto } from './dto/query-positions.dto';
import { SubmitLiquidityDto } from './dto/submit-liquidity.dto';
import { WithdrawLiquidityDto } from './dto/withdraw-liquidity.dto';
import {
  LiquidityOperationEntity,
  LiquidityOperationListEntity,
  LiquidityPoolEntity,
  LiquidityPoolListEntity,
  LiquidityPositionListEntity,
  LiquiditySubmitResultEntity,
} from './entities/liquidity-pool.entity';
import { LiquidityPoolsService } from './liquidity-pools.service';

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
  @ApiCreatedResponse({ type: LiquidityOperationEntity })
  deposit(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: DepositLiquidityDto,
  ) {
    return this.liquidity.deposit(consumer, dto);
  }

  @Post('withdraw')
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  @ApiOperation({
    summary:
      'Build a pool withdrawal (burn shares) → unsigned XDR + SEP-7 tx URI + QR',
  })
  @ApiCreatedResponse({ type: LiquidityOperationEntity })
  withdraw(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: WithdrawLiquidityDto,
  ) {
    return this.liquidity.withdraw(consumer, dto);
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
