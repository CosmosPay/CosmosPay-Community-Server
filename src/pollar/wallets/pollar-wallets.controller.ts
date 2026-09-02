import { Body, Controller, Delete, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
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

/**
 * Operator routes for Pollar wallets — `/v1/pollar`.
 *
 * These are the calls that need Pollar's *secret* key, which is exactly why they
 * live here and not in the wallet: a wallet can drive its own session against
 * Pollar directly, but it cannot fund a reserve, add a trustline, or ask whether
 * a token is genuine.
 */
@ApiTags('pollar')
@Controller({ path: 'pollar', version: '1' })
export class PollarWalletsController {
  constructor(private readonly wallets: PollarWalletsService) {}

  @Post('wallets/activate')
  @RequirePermissions('pollar:write')
  @ApiOperation({
    summary: "Fund a Pollar wallet's XLM reserve",
    description:
      'The Deferred funding mode: call it when your own rule says the user has ' +
      'earned an on-chain account. Idempotent — an already-funded wallet comes ' +
      'back with `activated: false`, not an error.',
  })
  @ApiCreatedResponse({ type: PollarActivationEntity })
  activate(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: ActivateWalletDto,
  ): Promise<PollarActivationEntity> {
    return this.wallets.activate(consumer, dto);
  }

  @Post('wallets/:address/trustlines/default')
  @RequirePermissions('pollar:write')
  @ApiOperation({
    summary: "Enable the app's configured assets on a wallet",
  })
  @ApiCreatedResponse({ type: PollarTrustlineEntity })
  defaultTrustlines(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('address') address: string,
  ): Promise<PollarTrustlineEntity> {
    return this.wallets.defaultTrustlines(consumer, address);
  }

  @Post('wallets/:address/trustlines')
  @RequirePermissions('pollar:write')
  @ApiOperation({ summary: 'Enable specific assets on a wallet' })
  @ApiCreatedResponse({ type: PollarTrustlineEntity })
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
