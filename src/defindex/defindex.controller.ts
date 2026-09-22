import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RequireAnyPermission } from '@/common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { DefindexService } from '@/defindex/defindex.service';
import {
  DefindexBalanceQueryDto,
  DefindexDepositDto,
  DefindexSubmitDto,
  DefindexVaultParamsDto,
  DefindexWithdrawDto,
} from '@/defindex/dto/defindex.dto';

@ApiTags('DeFindex')
@Controller('v1/defindex')
@AllowPublicKey()
export class DefindexController {
  constructor(private readonly defindex: DefindexService) {}

  @Get('vaults')
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({ summary: 'Discover DeFindex vaults' })
  vaults(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.defindex.discover(consumer);
  }

  @Get('vaults/:vault')
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({ summary: 'Read a DeFindex vault' })
  info(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param() params: DefindexVaultParamsDto,
  ) {
    return this.defindex.info(consumer, params.vault);
  }

  @Get('vaults/:vault/balance')
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({ summary: 'Read an account balance in a DeFindex vault' })
  balance(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param() params: DefindexVaultParamsDto,
    @Query() query: DefindexBalanceQueryDto,
  ) {
    return this.defindex.balance(consumer, params.vault, query.account);
  }

  @Post('vaults/:vault/deposit')
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  @ApiOperation({ summary: 'Build an unsigned DeFindex deposit' })
  deposit(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param() params: DefindexVaultParamsDto,
    @Body() dto: DefindexDepositDto,
  ) {
    return this.defindex.deposit(consumer, params.vault, dto);
  }

  @Post('vaults/:vault/withdraw')
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  @ApiOperation({ summary: 'Build an unsigned DeFindex share withdrawal' })
  withdraw(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param() params: DefindexVaultParamsDto,
    @Body() dto: DefindexWithdrawDto,
  ) {
    return this.defindex.withdraw(consumer, params.vault, dto);
  }

  @Post('submit')
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  @ApiOperation({ summary: 'Submit a signed DeFindex transaction' })
  submit(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: DefindexSubmitDto,
  ) {
    return this.defindex.submit(consumer, dto);
  }
}
