import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { resolveNetwork } from '@/common/stellar-network';
import { AppConfig } from '@/config/configuration';
import { PollarApiError, PollarClient } from '@/pollar/pollar.client';
import type {
  PollarActivationContent,
  PollarTokenVerifyContent,
} from '@/pollar/pollar.types';
import {
  asId,
  asPollarWallet,
  toPollarWalletEntity,
} from '@/pollar/pollar.util';
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

/**
 * The operator half of the Pollar integration: the calls that need the *secret*
 * key and therefore cannot be made by a wallet.
 *
 * These do not move a user's money — Pollar's own security model is that nothing
 * outside the user's key can — they set up the account it lives in: fund its
 * reserve, add the trustlines an asset needs, register a user before their first
 * login, and vouch for a token a wallet presents.
 *
 * Everything here is a thin pass-through by design. Pollar owns this state; a
 * local mirror of it would be a second source of truth for facts we do not
 * control, drifting the moment a wallet is funded from the Pollar dashboard.
 */
@Injectable()
export class PollarWalletsService {
  private readonly logger = new Logger(PollarWalletsService.name);

  constructor(
    private readonly pollar: PollarClient,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Funds the wallet's XLM reserve.
   *
   * Idempotent at Pollar, which reports a second call as `WALLET_ALREADY_FUNDED`
   * (409). That is a success from the caller's point of view — the wallet is
   * funded, which is what they asked for — so it comes back as `activated:
   * false` rather than an error the caller has to special-case.
   */
  async activate(
    consumer: GatewayConsumer,
    dto: ActivateWalletDto,
  ): Promise<PollarActivationEntity> {
    const network = resolveNetwork(this.config, consumer);
    try {
      const result = await this.pollar.server<PollarActivationContent>(
        'POST',
        network,
        '/wallets/activate',
        { body: { publicKey: dto.public_key } },
      );
      return {
        public_key: result.publicKey,
        amount: result.amount,
        activated: true,
      };
    } catch (err) {
      if (
        err instanceof PollarApiError &&
        err.code === 'WALLET_ALREADY_FUNDED'
      ) {
        return { public_key: dto.public_key, amount: '0', activated: false };
      }
      throw this.toApiError(err, 'activate wallet');
    }
  }

  /** Enables every asset configured for the Pollar app on this wallet. */
  defaultTrustlines(
    consumer: GatewayConsumer,
    address: string,
  ): Promise<PollarTrustlineEntity> {
    return this.trustlineCall(
      consumer,
      'POST',
      `/wallets/${encodeURIComponent(address)}/trustlines/default`,
      'SERVER_TRUSTLINES_ENABLED',
    );
  }

  /** Enables the named assets on this wallet. */
  createTrustlines(
    consumer: GatewayConsumer,
    address: string,
    dto: CreateTrustlinesDto,
  ): Promise<PollarTrustlineEntity> {
    return this.trustlineCall(
      consumer,
      'POST',
      `/wallets/${encodeURIComponent(address)}/trustlines`,
      'SERVER_TRUSTLINES_ENABLED',
      { assets: dto.assets },
    );
  }

  /**
   * Removes a trustline. Pollar refuses one that still holds a balance
   * (`TRUSTLINE_HAS_BALANCE`) — Stellar's own rule, not a policy of ours.
   */
  removeTrustline(
    consumer: GatewayConsumer,
    address: string,
    code: string,
    issuer: string,
  ): Promise<PollarTrustlineEntity> {
    // Pollar addresses the asset as a single `CODE:ISSUER` path segment, so the
    // colon has to survive encoding as a literal.
    const asset = `${encodeURIComponent(code)}:${encodeURIComponent(issuer)}`;
    return this.trustlineCall(
      consumer,
      'DELETE',
      `/wallets/${encodeURIComponent(address)}/trustlines/${asset}`,
      // Removal has its own code; reporting the "enabled" one here said the
      // opposite of what happened.
      'SERVER_TRUSTLINE_DISABLED',
    );
  }

  /**
   * Registers a user with Pollar. With `withWallet`, provisions their Stellar
   * wallet in the same call instead of waiting for their first login to do it.
   */
  async registerUser(
    consumer: GatewayConsumer,
    dto: RegisterUserDto,
    withWallet: boolean,
  ): Promise<PollarUserEntity> {
    const network = resolveNetwork(this.config, consumer);
    const code = withWallet
      ? 'SERVER_USER_WALLET_CREATED'
      : 'SERVER_USER_REGISTERED';
    try {
      const content = await this.pollar.server<Record<string, unknown>>(
        'POST',
        network,
        withWallet ? '/users/with-wallet' : '/users',
        {
          body: {
            externalId: dto.external_id,
            ...(dto.email ? { email: dto.email } : {}),
            ...(dto.first_name ? { firstName: dto.first_name } : {}),
            ...(dto.last_name ? { lastName: dto.last_name } : {}),
            ...(dto.avatar ? { avatar: dto.avatar } : {}),
          },
        },
      );
      // Pollar publishes the result code for these routes but not the shape of
      // their content, so it is read defensively and projected — see
      // `PollarUserEntity` for why the payload is not relayed as-is.
      const wallet = asPollarWallet(content.wallet);
      return {
        external_id: dto.external_id,
        code,
        user_id: asId(content.id) ?? asId(content.userId),
        ...(wallet ? { wallet: toPollarWalletEntity(wallet) } : {}),
      };
    } catch (err) {
      throw this.toApiError(err, 'register user');
    }
  }

  /**
   * Validates an end-user access token and returns what Pollar vouches for.
   *
   * The check has to happen with the secret key, server-side: a wallet holding a
   * token can claim anything about it, and only Pollar can say whether the token
   * is live, unexpired, and minted for *this* application — the last of which is
   * the one an attacker with a valid token from some other Pollar app would
   * otherwise walk straight through.
   */
  async verifyToken(
    consumer: GatewayConsumer,
    dto: VerifyTokenDto,
  ): Promise<PollarTokenClaimsEntity> {
    const network = resolveNetwork(this.config, consumer);
    try {
      const claims = await this.pollar.server<PollarTokenVerifyContent>(
        'POST',
        network,
        '/tokens/verify',
        { body: { token: dto.token } },
      );
      return {
        user_id: claims.userId,
        application_id: claims.applicationId,
        expires_at: claims.expiresAt,
        network: claims.network,
        auth_provider: claims.authProvider,
        ...(claims.wallet
          ? { wallet: toPollarWalletEntity(claims.wallet) }
          : {}),
      };
    } catch (err) {
      throw this.toApiError(err, 'verify token');
    }
  }

  private async trustlineCall(
    consumer: GatewayConsumer,
    method: string,
    path: string,
    successCode: string,
    body?: unknown,
  ): Promise<PollarTrustlineEntity> {
    const network = resolveNetwork(this.config, consumer);
    try {
      // The trustline routes carry their result in the envelope's `code` and
      // nothing of interest in `content`. `PollarClient` unwraps to `content`,
      // so the route's own documented success code is passed in rather than
      // read back — a 2xx here means exactly that code happened.
      await this.pollar.server<unknown>(method, network, path, { body });
      return { code: successCode };
    } catch (err) {
      throw this.toApiError(err, 'change trustlines');
    }
  }

  /**
   * Relays a Pollar failure with its own code intact — `WALLET_NOT_FOUND`,
   * `INSUFFICIENT_FUNDS_FOR_TRUSTLINE`, `SDK_AUTH_TOKEN_EXPIRED` are all things
   * the caller acts on differently, and all arrive as a bare 4xx otherwise.
   */
  private toApiError(err: unknown, action: string): Error {
    if (!(err instanceof PollarApiError)) {
      return err instanceof Error ? err : new Error(String(err));
    }
    this.logger.warn(`Pollar ${action} rejected: ${err.code}`);
    if (err.status >= 400 && err.status < 500) {
      return new ApiError(
        err.status,
        ApiErrorCode.ProviderError,
        `Pollar rejected the request (${err.code})`,
      );
    }
    return ApiError.badGateway(
      ApiErrorCode.ProviderError,
      'Pollar returned an error. Retry shortly.',
    );
  }
}
