import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PollarWalletStatus } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { isElevatedConsumer } from '@/common/elevated-consumer';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { resolveNetwork } from '@/common/stellar-network';
import { AppConfig, StellarNetwork } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { PollarApiError, PollarClient } from '@/pollar/pollar.client';
import type {
  PollarActivationContent,
  PollarTokenVerifyContent,
  PollarWallet,
} from '@/pollar/pollar.types';
import {
  asId,
  asPollarWallet,
  toPollarWalletEntity,
  walletAddress,
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
 * Pollar's state is not mirrored here. Pollar owns it; a local copy would be a
 * second source of truth for facts we do not control, drifting the moment a
 * wallet is funded from the Pollar dashboard. What this service does rely on is
 * the one fact Pollar cannot know: **which tenant a wallet came to**. Every
 * tenant shares the same secret keys, so Pollar acts on any address it custodies
 * for whoever asks, and the routes that name a wallet are only safe behind
 * {@link assertWalletOwned}.
 */
@Injectable()
export class PollarWalletsService {
  private readonly logger = new Logger(PollarWalletsService.name);

  constructor(
    private readonly pollar: PollarClient,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
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
    await this.assertWalletOwned(consumer, network, dto.public_key);
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
      address,
      'POST',
      '/trustlines/default',
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
      address,
      'POST',
      '/trustlines',
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
      address,
      'DELETE',
      `/trustlines/${asset}`,
      // Removal has its own code; reporting the "enabled" one here said the
      // opposite of what happened.
      'SERVER_TRUSTLINE_DISABLED',
    );
  }

  /**
   * Registers a user with Pollar. With `withWallet`, provisions their Stellar
   * wallet in the same call instead of waiting for their first login to do it.
   *
   * **Elevated keys only.** Every tenant shares one Pollar application, so a user
   * registered here is the same user a later social login resolves by email. A
   * tenant key could register a stranger's email, be recorded as the owner of the
   * wallet Pollar created for it, and strip that person's trustlines once they
   * start using it — or spend the operator's XLM on wallets for addresses it
   * made up.
   */
  async registerUser(
    consumer: GatewayConsumer,
    dto: RegisterUserDto,
    withWallet: boolean,
  ): Promise<PollarUserEntity> {
    if (!isElevatedConsumer(consumer)) {
      this.logger.warn(
        `Refused Pollar user registration for ${consumer.username}: not an elevated key`,
      );
      throw ApiError.forbidden(
        ApiErrorCode.ElevatedKeyRequired,
        'Registering Pollar users requires an elevated (admin) key: the Pollar ' +
          'user directory is shared by every tenant.',
      );
    }
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
      const userId = asId(content.id) ?? asId(content.userId);
      if (wallet) {
        await this.rememberProvisioned(
          consumer,
          network,
          dto.external_id,
          wallet,
          userId,
        );
      }
      return {
        external_id: dto.external_id,
        code,
        user_id: userId,
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

  /**
   * One trustline call against `address`. The ownership check lives here rather
   * than in each route, so a trustline route added later cannot forget it.
   */
  private async trustlineCall(
    consumer: GatewayConsumer,
    address: string,
    method: string,
    route: string,
    successCode: string,
    body?: unknown,
  ): Promise<PollarTrustlineEntity> {
    const network = resolveNetwork(this.config, consumer);
    await this.assertWalletOwned(consumer, network, address);
    try {
      // The trustline routes carry their result in the envelope's `code` and
      // nothing of interest in `content`. `PollarClient` unwraps to `content`,
      // so the route's own documented success code is passed in rather than
      // read back — a 2xx here means exactly that code happened.
      await this.pollar.server<unknown>(
        method,
        network,
        `/wallets/${encodeURIComponent(address)}${route}`,
        { body },
      );
      return { code: successCode };
    } catch (err) {
      throw this.toApiError(err, 'change trustlines');
    }
  }

  /**
   * 404s unless this consumer is on record as having got `address`, on this
   * network, through this service.
   *
   * Every tenant shares the same Pollar secret keys, so Pollar acts on any
   * address it custodies no matter who asks. Forwarding `:address` straight
   * through let one tenant strip the trustlines off another tenant's user —
   * breaking their incoming USDC — or loop reserve-consuming trustlines onto
   * wallets it had never seen, paid for out of the operator's funding wallet.
   * It is the Pollar counterpart of `assertQuoteOwned` on the BlindPay side.
   *
   * Two records count, and between them they cover every way this service hands
   * a caller an address:
   *
   *   - **a login it redeemed** — the handshake row keeps the address the
   *     redemption returned. Both the wallet's own flow and the dev platform's
   *     brokered one call these routes as the consumer that redeemed the code.
   *   - **a wallet it provisioned** — the counterpart network of a login, or
   *     `POST /v1/pollar/users/with-wallet` (see {@link rememberProvisioned}).
   *
   * The network is part of the match: Pollar's mainnet and testnet are separate
   * applications, and an address from one is not a wallet on the other.
   *
   * 404 rather than 403, and one message for every miss: a 403 would confirm the
   * address is live for somebody else.
   */
  private async assertWalletOwned(
    consumer: GatewayConsumer,
    network: StellarNetwork,
    address: string,
  ): Promise<void> {
    const local = await this.consumers.resolve(consumer);
    // A login is by far the common origin, so it is asked first and the
    // provisioning table only on a miss.
    const login = await this.prisma.pollarOauthSession.findFirst({
      where: { consumerId: local.id, network, walletAddress: address },
      select: { id: true },
    });
    if (login) return;

    const provisioned = await this.prisma.pollarUserWallet.findFirst({
      where: { consumerId: local.id, network, address },
      select: { id: true },
    });
    if (!provisioned) {
      throw ApiError.notFound('Wallet not found');
    }
  }

  /**
   * Records a wallet this consumer just had Pollar create, so the routes above
   * recognise it as theirs. Without it, `POST /v1/pollar/users/with-wallet`
   * would hand out an address its own trustline routes then refuse.
   *
   * `pollar_user_wallet` rather than a table of its own, because it already is
   * the per-consumer, per-network record of wallets this service provisioned,
   * and a `READY` row is inert to the provisioning sweeper, which only claims
   * `PENDING` ones. `externalId` is the operator's handle here rather than an
   * OAuth email. When the two happen to coincide, a later login on the other
   * network finds this wallet already provisioned instead of asking Pollar to
   * register the same user again — which is the right answer.
   *
   * Best-effort: by now the user and wallet exist at Pollar, and failing the
   * response would only send the caller into a retry Pollar refuses as a
   * duplicate. A lost write costs a 404 on this wallet's routes — the safe
   * direction to fail in — and is logged.
   */
  private async rememberProvisioned(
    consumer: GatewayConsumer,
    network: StellarNetwork,
    externalId: string,
    wallet: PollarWallet,
    pollarUserId: string | null,
  ): Promise<void> {
    const provisioned = {
      status: PollarWalletStatus.READY,
      address: walletAddress(wallet),
      walletType: wallet.type,
      pollarUserId,
      errorCode: null,
      nextAttemptAt: null,
    };
    try {
      const local = await this.consumers.resolve(consumer);
      await this.prisma.pollarUserWallet.upsert({
        where: {
          consumerId_externalId_network: {
            consumerId: local.id,
            externalId,
            network,
          },
        },
        create: { consumerId: local.id, externalId, network, ...provisioned },
        update: provisioned,
      });
    } catch (err) {
      this.logger.error(
        `Could not record the Pollar ${network} wallet just provisioned; its wallet routes will 404`,
        err as Error,
      );
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
