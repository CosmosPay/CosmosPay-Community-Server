import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RequireAnyPermission } from '@/common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { DefindexService } from '@/native-plugins/defindex/defindex.service';
import {
  DefindexBalanceQueryDto,
  DefindexDepositDto,
  DefindexSubmitDto,
  DefindexVaultParamsDto,
  DefindexWithdrawDto,
} from '@/native-plugins/defindex/dto/defindex.dto';

@ApiTags('DeFindex')
// No `v1/` here: URI versioning adds it, and writing it twice served every
// route at /v1/v1/defindex while the wallet calls /v1/defindex.
@Controller('defindex')
@AllowPublicKey()
export class DefindexController {
  constructor(private readonly defindex: DefindexService) {}

  @Get('vaults')
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({
    summary: 'Discover DeFindex vaults',
    description:
      "The DeFindex vaults on the key's network (a `prod` key reads mainnet, " +
      "a `dev` key testnet), with DeFindex's answer passed through as is. " +
      'DeFindex failures are `502 provider_error`, and a deployment ' +
      'without a DeFindex API key answers `503 misconfigured`.',
  })
  vaults(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.defindex.discover(consumer);
  }

  @Get('vaults/:vault')
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({
    summary: 'Read a DeFindex vault',
    description:
      "One vault's details from DeFindex on the key's network, passed " +
      'through as is; `vault` is its contract address (`C...`). ' +
      'DeFindex failures are `502 provider_error`, and a deployment ' +
      'without a DeFindex API key answers `503 misconfigured`.',
  })
  info(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param() params: DefindexVaultParamsDto,
  ) {
    return this.defindex.info(consumer, params.vault);
  }

  @Get('vaults/:vault/balance')
  @RequireAnyPermission('liquidity:read', 'swaps:read')
  @ApiOperation({
    summary: 'Read an account balance in a DeFindex vault',
    description:
      "`account`'s shares and their underlying value in the vault, read from " +
      "DeFindex on the key's network and passed through as is. " +
      'DeFindex failures are `502 provider_error`, and a deployment ' +
      'without a DeFindex API key answers `503 misconfigured`.',
  })
  balance(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param() params: DefindexVaultParamsDto,
    @Query() query: DefindexBalanceQueryDto,
  ) {
    return this.defindex.balance(consumer, params.vault, query.account);
  }

  @Post('vaults/:vault/deposit')
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  @ApiOperation({
    summary: 'Build an unsigned DeFindex deposit',
    description:
      'DeFindex builds the deposit of `amounts` (integer strings) into the ' +
      "vault for `caller` to sign, on the key's network; `invest` defaults " +
      'to true and `slippageBps` to 100. Nothing is stored here: sign the ' +
      'returned XDR and send it to `POST /v1/defindex/submit`. ' +
      'DeFindex failures are `502 provider_error`, and a deployment ' +
      'without a DeFindex API key answers `503 misconfigured`.',
  })
  deposit(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param() params: DefindexVaultParamsDto,
    @Body() dto: DefindexDepositDto,
  ) {
    return this.defindex.deposit(consumer, params.vault, dto);
  }

  @Post('vaults/:vault/withdraw')
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  @ApiOperation({
    summary: 'Build an unsigned DeFindex share withdrawal',
    description:
      'DeFindex builds the burn of `shares` (an integer string) for the ' +
      "vault's underlying assets, for `caller` to sign on the key's network; " +
      '`slippageBps` defaults to 100. Nothing is stored here: sign the ' +
      'returned XDR and send it to `POST /v1/defindex/submit`. ' +
      'DeFindex failures are `502 provider_error`, and a deployment ' +
      'without a DeFindex API key answers `503 misconfigured`.',
  })
  withdraw(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param() params: DefindexVaultParamsDto,
    @Body() dto: DefindexWithdrawDto,
  ) {
    return this.defindex.withdraw(consumer, params.vault, dto);
  }

  @Post('submit')
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  @ApiOperation({
    summary: 'Submit a signed DeFindex transaction',
    description:
      "Sends the signed `xdr` to the key's network through DeFindex and " +
      'passes its answer through (hash, success, ledger). The XDR is not ' +
      'checked against one built here, and nothing is stored. ' +
      'DeFindex failures are `502 provider_error`, and a deployment ' +
      'without a DeFindex API key answers `503 misconfigured`.',
  })
  submit(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: DefindexSubmitDto,
  ) {
    return this.defindex.submit(consumer, dto);
  }
}
