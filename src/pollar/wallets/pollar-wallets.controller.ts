import { Body, Controller, Delete, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  type ApiResponseOptions,
} from '@nestjs/swagger';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { API_ERROR_BODY_CONTENT } from '@/common/errors/api-error.entity';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { ActivateWalletDto } from '@/pollar/wallets/dto/activate-wallet.dto';
import { CreateTrustlinesDto } from '@/pollar/wallets/dto/create-trustlines.dto';
import { RegisterUserDto } from '@/pollar/wallets/dto/register-user.dto';
import { VerifyTokenDto } from '@/pollar/wallets/dto/verify-token.dto';
import {
  PollarActivationEntity,
  PollarTrustlineEntity,
} from '@/pollar/wallets/entities/pollar-activation.entity';
import { PollarTokenClaimsEntity } from '@/pollar/wallets/entities/pollar-token-claims.entity';
import { PollarUserEntity } from '@/pollar/wallets/entities/pollar-user.entity';
import { PollarWalletsService } from '@/pollar/wallets/pollar-wallets.service';
import {
  POLLAR_ACTIVATE_RATE_LIMIT,
  POLLAR_PROVISION_RATE_LIMIT,
  POLLAR_TRUSTLINE_RATE_LIMIT,
} from '@/pollar/pollar.constants';

/**
 * The 404 of every route that names a wallet. An unknown address and another
 * tenant's address are one response on purpose (see `assertWalletOwned`), so
 * they get one description as well: documenting two would publish the very
 * distinction the route refuses to make.
 */
const WALLET_NOT_FOUND_RESPONSE: ApiResponseOptions = {
  status: 404,
  description:
    'Wallet not found (`not_found`): the address is unknown, or this consumer ' +
    'did not obtain it through this service. Both cases answer identically, so ' +
    'the response never reveals whether the wallet belongs to someone else.',
  content: API_ERROR_BODY_CONTENT,
};

/** The 429 of the two POST trustline routes, which share one budget. */
const TRUSTLINE_RATE_LIMITED_RESPONSE: ApiResponseOptions = {
  status: 429,
  description:
    'Rate limited (`rate_limited`). Both POST trustline routes draw on the same ' +
    'budget per consumer and client address, so alternating between them does ' +
    'not reset it. Honour `Retry-After`.',
  content: API_ERROR_BODY_CONTENT,
};

/**
 * Operator routes for Pollar wallets — `/v1/pollar`.
 *
 * These are the calls that need Pollar's *secret* key, which is exactly why they
 * live here and not in the wallet: a wallet can drive its own session against
 * Pollar directly, but it cannot fund a reserve, add a trustline, or ask whether
 * a token is genuine.
 *
 * Every route that names a wallet answers 404 unless the calling consumer got
 * that wallet through this service — every tenant shares the same secret keys,
 * so Pollar itself cannot tell them apart. See `assertWalletOwned`.
 */
@ApiTags('pollar')
@Controller({ path: 'pollar', version: '1' })
export class PollarWalletsController {
  constructor(private readonly wallets: PollarWalletsService) {}

  @Post('wallets/activate')
  @RequirePermissions('pollar:write')
  // Spends XLM out of the funding wallet on every call that does real work.
  @RateLimit(POLLAR_ACTIVATE_RATE_LIMIT)
  @ApiOperation({
    summary: "Fund a Pollar wallet's XLM reserve",
    description:
      'The Deferred funding mode: call it when your own rule says the user has ' +
      'earned an on-chain account. Idempotent — an already-funded wallet comes ' +
      'back with `activated: false`, not an error.',
  })
  @ApiCreatedResponse({ type: PollarActivationEntity })
  @ApiResponse(WALLET_NOT_FOUND_RESPONSE)
  activate(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: ActivateWalletDto,
  ): Promise<PollarActivationEntity> {
    return this.wallets.activate(consumer, dto);
  }

  @Post('wallets/:address/trustlines/default')
  @RequirePermissions('pollar:write')
  // Locks reserve out of the funding wallet per asset. Shares its bucket with
  // the explicit route below, so alternating the two buys a loop nothing.
  @RateLimit(POLLAR_TRUSTLINE_RATE_LIMIT)
  @ApiOperation({
    summary: "Enable the app's configured assets on a wallet",
  })
  @ApiCreatedResponse({ type: PollarTrustlineEntity })
  @ApiResponse(WALLET_NOT_FOUND_RESPONSE)
  @ApiResponse(TRUSTLINE_RATE_LIMITED_RESPONSE)
  defaultTrustlines(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('address') address: string,
  ): Promise<PollarTrustlineEntity> {
    return this.wallets.defaultTrustlines(consumer, address);
  }

  @Post('wallets/:address/trustlines')
  @RequirePermissions('pollar:write')
  // Up to 25 reserve-consuming assets per call — same bucket as /default.
  @RateLimit(POLLAR_TRUSTLINE_RATE_LIMIT)
  @ApiOperation({ summary: 'Enable specific assets on a wallet' })
  @ApiCreatedResponse({ type: PollarTrustlineEntity })
  @ApiResponse(WALLET_NOT_FOUND_RESPONSE)
  @ApiResponse(TRUSTLINE_RATE_LIMITED_RESPONSE)
  createTrustlines(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('address') address: string,
    @Body() dto: CreateTrustlinesDto,
  ): Promise<PollarTrustlineEntity> {
    return this.wallets.createTrustlines(consumer, address, dto);
  }

  @Delete('wallets/:address/trustlines/:code/:issuer')
  @RequirePermissions('pollar:write')
  @ApiOperation({
    summary: 'Remove a trustline',
    description:
      'The asset must hold a zero balance. Code and issuer are separate path ' +
      "segments here; Pollar's own route joins them with a colon, which this " +
      'service does on the way out so neither has to be escaped by the caller.',
  })
  @ApiOkResponse({ type: PollarTrustlineEntity })
  @ApiResponse(WALLET_NOT_FOUND_RESPONSE)
  removeTrustline(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('address') address: string,
    @Param('code') code: string,
    @Param('issuer') issuer: string,
  ): Promise<PollarTrustlineEntity> {
    return this.wallets.removeTrustline(consumer, address, code, issuer);
  }

  @Post('users')
  @RequirePermissions('pollar:write')
  @ApiOperation({
    summary: 'Register a user with Pollar ahead of their first login',
    description:
      'The account then exists before the user ever sees a consent screen. ' +
      'Pollar does not publish the content shape of this route, so the response ' +
      'is a narrow projection of it rather than the provider payload.',
  })
  @ApiCreatedResponse({ type: PollarUserEntity })
  registerUser(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: RegisterUserDto,
  ): Promise<PollarUserEntity> {
    return this.wallets.registerUser(consumer, dto, false);
  }

  @Post('users/with-wallet')
  @RequirePermissions('pollar:write')
  // Creates a wallet with no consent screen pacing it — the tightest budget.
  @RateLimit(POLLAR_PROVISION_RATE_LIMIT)
  @ApiOperation({
    summary: 'Register a user and provision their Stellar wallet',
    description:
      'Same body as POST /v1/pollar/users, but the Stellar wallet is created in ' +
      'the same call instead of waiting for the first login to do it.',
  })
  @ApiCreatedResponse({ type: PollarUserEntity })
  registerUserWithWallet(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: RegisterUserDto,
  ): Promise<PollarUserEntity> {
    return this.wallets.registerUser(consumer, dto, true);
  }

  @Post('tokens/verify')
  @RequirePermissions('pollar:read')
  @ApiOperation({
    summary: 'Validate a Pollar end-user access token',
    description:
      'Use this before trusting a token a wallet presents to your backend. It ' +
      'also proves the token was minted for your Pollar application, which a ' +
      'local JWT decode cannot.',
  })
  @ApiCreatedResponse({ type: PollarTokenClaimsEntity })
  verifyToken(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: VerifyTokenDto,
  ): Promise<PollarTokenClaimsEntity> {
    return this.wallets.verifyToken(consumer, dto);
  }
}
