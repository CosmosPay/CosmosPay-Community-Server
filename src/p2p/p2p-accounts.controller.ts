import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { PaginationQueryDto } from '@/common/dto/pagination.query.dto';
import { ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import {
  CreateP2pMarketChallengeDto,
  RegisterP2pMarketAccountDto,
  UpdateP2pMarketAccountDto,
} from '@/p2p/dto/p2p-account.dto';
import {
  CreateP2pMarketPaymentMethodDto,
  QueryP2pMarketPaymentMethodsDto,
  UpdateP2pMarketPaymentMethodDto,
} from '@/p2p/dto/p2p-payment-method.dto';
import {
  P2pMarketAccountDetailEntity,
  P2pMarketAccountEntity,
  P2pMarketAccountListEntity,
  P2pMarketChallengeEntity,
  P2pMarketPaymentMethodEntity,
  P2pMarketPaymentMethodListEntity,
} from '@/p2p/entities/p2p-account.entity';
import { P2pNetworkRefusal, P2pRowIdParam } from '@/p2p/p2p-api-docs';
import { P2pAccountsService } from '@/p2p/p2p-accounts.service';
import { P2pPaymentMethodsService } from '@/p2p/p2p-payment-methods.service';
import { P2P_ACCOUNT_READ_RATE_LIMIT } from '@/p2p/p2p.constants';

const ACCOUNT_ID = P2pRowIdParam('account', 'cm3p2pacc0001l70g8v5q3z2w');
const METHOD_ID = P2pRowIdParam('payment method', 'cm3p2ppm00001l70g8v5q3z2w');

/** `/v1/p2p/accounts` and `/v1/p2p/payment-methods`: the wallets a consumer trades from, and where they get paid. */
@ApiTags('p2p-market')
@Controller({ path: 'p2p', version: '1' })
export class P2pAccountsController {
  constructor(
    private readonly accounts: P2pAccountsService,
    private readonly paymentMethods: P2pPaymentMethodsService,
  ) {}

  @Post('accounts/challenge')
  @RequirePermissions('p2p:write')
  @ApiOperation({
    summary: 'Get the message a wallet signs to register',
    description:
      'Answers a single-use message naming the wallet, this API consumer, the tier, a nonce and an expiry ten minutes away. Sign it with the wallet (`personal_sign`, EIP-191) and send the signature to `POST /v1/p2p/accounts`.',
  })
  @ApiCreatedResponse({ type: P2pMarketChallengeEntity })
  @P2pNetworkRefusal()
  challenge(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateP2pMarketChallengeDto,
  ) {
    return this.accounts.challenge(consumer, dto);
  }

  @Post('accounts')
  @RequirePermissions('p2p:write')
  @ApiOperation({
    summary: 'Register a wallet with its signature over a challenge',
    description:
      'The signature must recover the wallet over one of its open challenges for this consumer; that challenge is then used up. A wallet belongs to one consumer per tier. A registered account can hold a balance in the contract, publish offers as a merchant (with a `displayName`), receive charges and pay out.',
  })
  @ApiCreatedResponse({ type: P2pMarketAccountEntity })
  @P2pNetworkRefusal(
    ApiErrorCode.P2pChallengeInvalid,
    ApiErrorCode.P2pSignatureInvalid,
  )
  @ApiErrorResponse({ status: 409, codes: [ApiErrorCode.P2pAccountTaken] })
  register(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: RegisterP2pMarketAccountDto,
  ) {
    return this.accounts.register(consumer, dto);
  }

  @Get('accounts')
  @RequirePermissions('p2p:read')
  @ApiOperation({
    summary: 'List your registered wallets',
    description:
      'Newest first, on the key’s tier only, paginated with `take` (default 20, max 100) and `skip`; the answer is `{ data, total, take, skip }`.',
  })
  @ApiOkResponse({ type: P2pMarketAccountListEntity })
  @P2pNetworkRefusal()
  list(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: PaginationQueryDto,
  ) {
    return this.accounts.list(consumer, query);
  }

  @Get('accounts/:id')
  @RequirePermissions('p2p:read')
  @RateLimit(P2P_ACCOUNT_READ_RATE_LIMIT)
  @ApiOperation({
    summary: 'Get a wallet with its live balances and matcher terms',
    description:
      'The account, and per network the market runs on: its free balance of each token in the contract, what it allows the matcher (`maxPerOrder`, `autoSettle`) and the operators it granted, read from the chain now.',
  })
  @ACCOUNT_ID
  @ApiOkResponse({ type: P2pMarketAccountDetailEntity })
  @ApiUpstream('EVM network')
  @P2pNetworkRefusal()
  get(@CurrentConsumer() consumer: GatewayConsumer, @Param('id') id: string) {
    return this.accounts.get(consumer, id);
  }

  @Patch('accounts/:id')
  @RequirePermissions('p2p:write')
  @ApiOperation({
    summary:
      'Rename a wallet, set its merchant name, or pause it as a merchant',
    description:
      'PAUSED stops new orders from matching the account; its live orders go on. A suspension set by the platform cannot be lifted here (`invalid_state_transition`).',
  })
  @ACCOUNT_ID
  @ApiOkResponse({ type: P2pMarketAccountEntity })
  @P2pNetworkRefusal(ApiErrorCode.InvalidStateTransition)
  update(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: UpdateP2pMarketAccountDto,
  ) {
    return this.accounts.update(consumer, id, dto);
  }

  @Delete('accounts/:id')
  @RequirePermissions('p2p:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Forget a wallet, its payment methods and offers',
    description:
      'Refused while an order it is the merchant or the seller of is live. Its tokens are never touched: they stay in the contract, withdrawable by the wallet.',
  })
  @ACCOUNT_ID
  @ApiNoContentResponse({ description: 'Forgotten.' })
  @P2pNetworkRefusal()
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.OperationInFlight],
    examples: {
      [ApiErrorCode.OperationInFlight]: {
        summary: 'The account has live orders',
        message:
          'This account has live orders: wait until they end before removing it.',
        path: '/v1/p2p/accounts/cm3p2pacc0001l70g8v5q3z2w',
      },
    },
  })
  async remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    await this.accounts.remove(consumer, id);
  }

  @Post('payment-methods')
  @RequirePermissions('p2p:write')
  @ApiOperation({
    summary: 'Add where an account receives local money',
    description:
      'The details are checked per rail (CBU/CVU and CUIT check digits, CLABE, PIX keys by type, and the rest by shape) and sealed at rest. A merchant’s method on a rail is what a person pays on a purchase; it is shown to that counterparty only while the order is live.',
  })
  @ApiCreatedResponse({ type: P2pMarketPaymentMethodEntity })
  @P2pNetworkRefusal()
  createPaymentMethod(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateP2pMarketPaymentMethodDto,
  ) {
    return this.paymentMethods.create(consumer, dto);
  }

  @Get('payment-methods')
  @RequirePermissions('p2p:read')
  @ApiOperation({
    summary: 'List your payment methods',
    description:
      'Newest first, on the key’s tier, optionally for one `accountId`; paginated with `take` and `skip`. Each is shown in full: they are yours.',
  })
  @ApiOkResponse({ type: P2pMarketPaymentMethodListEntity })
  @P2pNetworkRefusal()
  listPaymentMethods(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryP2pMarketPaymentMethodsDto,
  ) {
    return this.paymentMethods.list(consumer, query);
  }

  @Patch('payment-methods/:id')
  @RequirePermissions('p2p:write')
  @ApiOperation({
    summary: 'Change a payment method',
    description:
      'New details are checked like a new method’s; the rail and currency never change. An inactive method is no longer shown on new orders, and an account with none active on a rail is not matched for purchases on it.',
  })
  @METHOD_ID
  @ApiOkResponse({ type: P2pMarketPaymentMethodEntity })
  @P2pNetworkRefusal()
  updatePaymentMethod(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: UpdateP2pMarketPaymentMethodDto,
  ) {
    return this.paymentMethods.update(consumer, id, dto);
  }

  @Delete('payment-methods/:id')
  @RequirePermissions('p2p:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a payment method',
    description:
      'A live order that named it no longer shows payment details to its payer: deactivate it instead while orders are open.',
  })
  @METHOD_ID
  @ApiNoContentResponse({ description: 'Deleted.' })
  @P2pNetworkRefusal()
  async removePaymentMethod(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    await this.paymentMethods.remove(consumer, id);
  }
}
