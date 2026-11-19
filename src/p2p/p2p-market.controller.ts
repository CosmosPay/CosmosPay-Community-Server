import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { BuildP2pMarketTransactionDto } from '@/p2p/dto/p2p-transaction.dto';
import { P2pMarketOverviewEntity } from '@/p2p/entities/p2p-market.entity';
import { P2pMarketTransactionEntity } from '@/p2p/entities/p2p-transaction.entity';
import { P2P_NETWORK_UNSUPPORTED_EXAMPLE } from '@/p2p/p2p-api-docs';
import { P2pMarketService } from '@/p2p/p2p-market.service';
import { P2pTransactionsService } from '@/p2p/p2p-transactions.service';

/**
 * `/v1/p2p`: the market overview and the transaction builder. The P2P
 * market's other routes live in the controllers beside this one, one per
 * resource, all under the same prefix and the `p2p-market` tag.
 */
@ApiTags('p2p-market')
@Controller({ path: 'p2p', version: '1' })
export class P2pMarketController {
  constructor(
    private readonly market: P2pMarketService,
    private readonly transactions: P2pTransactionsService,
  ) {}

  @Get('market')
  @RequirePermissions('p2p:read')
  @ApiOperation({
    summary:
      'The P2P market for this API key: networks, contracts, tokens, rails, fee and matcher',
    description:
      'Everything an integration needs on the key’s tier (a `prod` key: mainnet; a `dev` key: test networks): each network the market runs on, with its contract (checked against this service’s build), its tokens, the protocol fee and whether it is paused; the currencies and the fields of each payment rail; the order windows and the bond rate; and the matcher address a seller authorises with `setMatcher`. `available` is false, and `networks` empty, where the market does not run yet. A network whose node does not answer is left out of this answer.',
  })
  @ApiOkResponse({ type: P2pMarketOverviewEntity })
  @ApiUpstream('EVM network')
  overview(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.market.overview(consumer);
  }

  @Post('transactions')
  @RequirePermissions('p2p:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Build an unsigned transaction for a wallet or a bot to sign',
    description:
      'One of: `approve` / `deposit` / `withdraw` (`args`: `token`, `amount` in base units), `setOperator` (`operator`, `permissions` as bits or names: open, release, trade, withdraw; 0 revokes), `setMatcher` (`maxPerOrder` in base units, 0 revokes; `autoSettle`, refused for an account that sells tokens through offers), and the order actions `accept`, `markPaid`, `release`, `cancel`, `dispute` (`orderId`). `from` is one of your account ids (or addresses), or the seller’s address of one of your sales. An order action checks the order (yours as client or as merchant), its status and that `from` is the party that may act, so a wallet never signs what the contract would revert. Nothing is signed or sent here.',
  })
  @ApiOkResponse({ type: P2pMarketTransactionEntity })
  @ApiUpstream('EVM network')
  @ApiErrorResponse({
    status: 400,
    codes: [
      ApiErrorCode.NetworkUnsupported,
      ApiErrorCode.InvalidStateTransition,
    ],
    description:
      '`network_unsupported`: the P2P market does not run on that network for this key. `invalid_state_transition`: the order is not in a status that allows the action, or `from` is not the party that may take it. `validation_failed` also answers arguments the action cannot take.',
    examples: {
      ...P2P_NETWORK_UNSUPPORTED_EXAMPLE,
      [ApiErrorCode.InvalidStateTransition]: {
        summary: 'Only the seller releases',
        message: 'only the order’s seller releases it',
        path: '/v1/p2p/transactions',
      },
    },
  })
  build(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: BuildP2pMarketTransactionDto,
  ) {
    return this.transactions.build(consumer, dto);
  }
}
