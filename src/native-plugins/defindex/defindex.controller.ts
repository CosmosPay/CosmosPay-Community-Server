import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequireAnyPermission } from '@/common/decorators/require-permissions.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import {
  DEFINDEX_BUILD_RATE_LIMIT,
  DEFINDEX_SUBMIT_RATE_LIMIT,
} from '@/native-plugins/defindex/defindex.constants';
import { DefindexService } from '@/native-plugins/defindex/defindex.service';
import { DefindexTransactionsService } from '@/native-plugins/defindex/defindex-transactions.service';
import {
  DefindexBalanceQueryDto,
  DefindexDepositDto,
  DefindexSubmitDto,
  DefindexVaultParamsDto,
  DefindexWithdrawDto,
} from '@/native-plugins/defindex/dto/defindex.dto';
import {
  DefindexBuildEntity,
  DefindexSubmitResultEntity,
} from '@/native-plugins/defindex/entities/defindex.entity';

const SUBMIT_PATH = '/v1/defindex/submit';

@ApiTags('DeFindex')
// No `v1/` here: URI versioning adds it, and writing it twice served every
// route at /v1/v1/defindex while the wallet calls /v1/defindex.
@Controller('defindex')
// Every route calls DeFindex (a submit replay is answered from the table, but
// a first submit is not).
@ApiUpstream('DeFindex')
// No `@AllowPublicKey()`, on purpose. The shared public key exists for the
// anonymous swap pages and wallets, which never call DeFindex: the wallet's
// Earn screen uses the signed-in account's own key. Admitting it made every
// anonymous caller one consumer able to spend this deployment's DeFindex quota
// and, with the old submit, to relay any transaction through it.
export class DefindexController {
  constructor(
    private readonly defindex: DefindexService,
    private readonly transactions: DefindexTransactionsService,
  ) {}

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
  // Each build spends a call on the deployment's DeFindex key and stores a row.
  @RateLimit(DEFINDEX_BUILD_RATE_LIMIT)
  @ApiOperation({
    summary: 'Build an unsigned DeFindex deposit',
    description:
      'DeFindex builds the deposit of `amounts` (integer strings in minor ' +
      "units, at most 9007199254740991 each) into the vault for `caller` on the key's network; " +
      '`invest` defaults to true and `slippageBps` to 100. The returned XDR ' +
      'is checked to be exactly that call and recorded for this key for up ' +
      'to 15 minutes (less if its time bounds close sooner): sign it ' +
      'unchanged and send it to `POST /v1/defindex/submit`.',
  })
  @ApiCreatedResponse({ type: DefindexBuildEntity })
  deposit(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param() params: DefindexVaultParamsDto,
    @Body() dto: DefindexDepositDto,
  ) {
    return this.defindex.deposit(consumer, params.vault, dto);
  }

  @Post('vaults/:vault/withdraw')
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  @RateLimit(DEFINDEX_BUILD_RATE_LIMIT)
  @ApiOperation({
    summary: 'Build an unsigned DeFindex share withdrawal',
    description:
      'DeFindex builds the burn of `shares` (an integer string, at most ' +
      "9007199254740991) for the vault's underlying assets, for `caller` on " +
      "the key's network; `slippageBps` defaults to 100. The returned XDR is " +
      'checked to be exactly that call and recorded for this key for up to ' +
      '15 minutes (less if its time bounds close sooner): sign it unchanged ' +
      'and send it to `POST /v1/defindex/submit`.',
  })
  @ApiCreatedResponse({ type: DefindexBuildEntity })
  withdraw(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param() params: DefindexVaultParamsDto,
    @Body() dto: DefindexWithdrawDto,
  ) {
    return this.defindex.withdraw(consumer, params.vault, dto);
  }

  @Post('submit')
  @RequireAnyPermission('liquidity:write', 'swaps:write')
  // Every accepted submit is a broadcast on the deployment's DeFindex key.
  @RateLimit(DEFINDEX_SUBMIT_RATE_LIMIT)
  @ApiOperation({
    summary: 'Submit a signed DeFindex transaction',
    description:
      'Relays `xdr` through DeFindex only when it is a signed copy of a ' +
      'transaction that `POST /v1/defindex/vaults/{vault}/deposit` or ' +
      '`/withdraw` built for this same API key on its network, before it ' +
      'expires; anything else is refused before DeFindex is called. Relayed ' +
      "once: DeFindex's answer is stored, and submitting the same transaction " +
      'again answers it without calling DeFindex. When DeFindex gives no ' +
      'answer (502, 503) the same transaction may be submitted again.',
  })
  @ApiCreatedResponse({ type: DefindexSubmitResultEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.InvalidStateTransition],
    description:
      '`validation_failed`: the body fails validation, or `xdr` is not a ' +
      'transaction envelope, is a fee bump, or carries no signature. ' +
      '`invalid_state_transition`: the ' +
      'transaction expired before it was submitted; build a new one.',
    examples: {
      [ApiErrorCode.ValidationFailed]: {
        message:
          'xdr carries no signatures; sign the transaction before submitting it',
        path: SUBMIT_PATH,
      },
      [ApiErrorCode.InvalidStateTransition]: {
        message:
          'This DeFindex transaction expired before it was submitted and can ' +
          'no longer be relayed. Build a new one.',
        path: SUBMIT_PATH,
      },
    },
  })
  @ApiErrorResponse({
    status: 404,
    codes: [ApiErrorCode.NotFound],
    description:
      'No transaction built here for this API key on its network hashes to ' +
      'the signed one: it was changed after the build (anything but the ' +
      'signatures), built for another key or network, or never built here. ' +
      'The same answer for all of them.',
    examples: {
      [ApiErrorCode.NotFound]: {
        message:
          'This transaction was not built by POST /v1/defindex/vaults/{vault}/deposit ' +
          'or /withdraw for this API key on this network. Build it here, sign ' +
          'it unchanged, and submit it before it expires.',
        path: SUBMIT_PATH,
      },
    },
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.OperationInFlight],
    description:
      'Another submit of the same transaction is waiting for DeFindex. Submit ' +
      'again once it finishes to read its stored answer.',
    examples: {
      [ApiErrorCode.OperationInFlight]: {
        message:
          'This DeFindex transaction is already being submitted. Wait for that ' +
          'submit to finish, then submit it again to read its result.',
        path: SUBMIT_PATH,
      },
    },
  })
  submit(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: DefindexSubmitDto,
  ) {
    return this.transactions.submit(consumer, dto.xdr);
  }
}
