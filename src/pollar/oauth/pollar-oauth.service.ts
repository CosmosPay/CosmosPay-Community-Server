import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, PollarOauthSession } from '@generated/prisma/client';
import { PollarOauthStatus } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { resolveNetwork } from '@/common/stellar-network';
import { AppConfig, StellarNetwork } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { PollarApiError, PollarClient } from '@/pollar/pollar.client';
import {
  POLLAR_SESSION_POLL_INTERVAL_MS,
  POLLAR_SESSION_PROBE_INTERVAL_MS,
  POLLAR_SESSION_PROBE_TIMEOUT_MS,
  POLLAR_SESSION_READY,
  POLLAR_TERMINAL_SESSION_CODES,
} from '@/pollar/pollar.constants';
import {
  assertPollarRedirectAllowed,
  buildWalletRedirect,
} from '@/pollar/pollar-redirect-uri';
import type {
  PollarClientSession,
  PollarLoginContent,
  PollarLogoutContent,
  PollarRefreshContent,
  PollarSessionStatus,
  PollarWallet,
} from '@/pollar/pollar.types';
import { toPollarWalletEntity, walletAddress } from '@/pollar/pollar.util';
import {
  hashCode,
  mintCode,
  mintState,
  verifyPkce,
} from '@/pollar/oauth/pollar-oauth-code';
import { AuthorizeOauthDto } from '@/pollar/oauth/dto/authorize-oauth.dto';
import { ExchangeCodeDto } from '@/pollar/oauth/dto/exchange-code.dto';
import { LogoutSessionDto } from '@/pollar/oauth/dto/logout-session.dto';
import { RefreshSessionDto } from '@/pollar/oauth/dto/refresh-session.dto';
import {
  PollarLogoutEntity,
  PollarNetworkWalletEntity,
  PollarSessionEntity,
  PollarTokenPairEntity,
} from '@/pollar/oauth/entities/pollar-session.entity';
import { PollarWalletProvisioningService } from '@/pollar/wallets/pollar-wallet-provisioning.service';
import { PollarAuthorizationEntity } from '@/pollar/oauth/entities/pollar-authorization.entity';
import { PollarSessionStatusEntity } from '@/pollar/oauth/entities/pollar-session-status.entity';

/** What the callback hands back to the controller to put on the wire. */
export interface PollarCallbackOutcome {
  /** Set when the handshake registered a redirect URI: 302 the browser there. */
  redirectTo: string | null;
  /**
   * What to tell the user on the page shown when there is nowhere to redirect.
   * Never a code: in poll mode the wallet collects that over its own
   * authenticated channel, not from a page in a browser it does not control.
   */
  outcome: 'authorized' | 'already_handled';
  state: string;
}

/**
 * The OAuth bridge.
 *
 * Pollar's hosted login is built for a browser SDK: the page mints a client
 * session, sends the user to `GET /auth/{provider}` with the publishable key and
 * a `redirect_uri`, and then redeems the session for tokens. A wallet cannot
 * play that part — the `redirect_uri` must be a host Pollar has been told about,
 * which a loopback listener or a `cosmospay://` deep link never is, and the
 * assembly needs keys and session ids the wallet should not be handling.
 *
 * So this service stands in the middle, the way a console's login bridge does:
 * it owns the whole Pollar-facing handshake and exposes a two-step contract the
 * wallet already knows — open an authorization, redeem a code. The wallet
 * absorbs a code and nothing else; what comes back is a live Pollar session it
 * can drive the virtual wallet with directly.
 *
 * Two properties are load-bearing:
 *
 *   - **No Pollar token is ever persisted.** The `/auth/login` exchange runs
 *     inside the redemption request, so the tokens exist in this process for the
 *     length of one response and nowhere else. A handshake row holds a code
 *     *hash* and a public Stellar address, and that is all it can leak.
 *   - **The code is single-use, and the burn is a compare-and-swap.** Two
 *     wallets racing the same code cannot both win, because the transition out
 *     of `AUTHORIZED` is the same `updateMany` that finds the row.
 */
@Injectable()
export class PollarOauthService {
  private readonly logger = new Logger(PollarOauthService.name);
  private readonly cfg: AppConfig['pollar'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly pollar: PollarClient,
    private readonly consumers: ConsumerResolverService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly provisioning: PollarWalletProvisioningService,
  ) {
    this.cfg = config.get('pollar', { infer: true });
  }

  // ── 1. Open a handshake ───────────────────────────────────────────────────

  /**
   * Mints a Pollar client session, records the handshake, and returns the URL
   * the wallet should open. This is the "assemble the query" half of the bridge:
   * the publishable key, the client session id and the callback are put together
   * here so the wallet never holds any of them.
   */
  async authorize(
    consumer: GatewayConsumer,
    dto: AuthorizeOauthDto,
  ): Promise<PollarAuthorizationEntity> {
    const network = resolveNetwork(this.config, consumer);
    const local = await this.consumers.resolve(consumer);

    const redirectUri = dto.redirect_uri
      ? assertPollarRedirectAllowed(
          consumer.username,
          dto.redirect_uri,
          this.cfg.redirectUriWhitelist,
        )
      : null;

    // Fail on a missing callback URL before spending a Pollar session on it.
    const state = mintState();
    const callbackUrl = this.pollar.callbackUrl(state);

    // Mapped rather than left to escape: a raw PollarApiError is not an
    // HttpException, so the global filter renders it as a bare 500
    // `internal_error` with Pollar's own code — the one thing that says what
    // actually went wrong — thrown away. Every other Pollar call in this
    // service already goes through `toApiError`; this one was the exception.
    let session: PollarClientSession;
    try {
      session = await this.pollar.sdk<PollarClientSession>(
        'POST',
        network,
        '/auth/session',
      );
    } catch (err) {
      throw this.toApiError(err, 'open a login');
    }

    const expiresAt = new Date(Date.now() + this.cfg.authorizationTtlMs);
    await this.prisma.pollarOauthSession.create({
      data: {
        consumerId: local.id,
        state,
        provider: dto.provider,
        network,
        clientSessionId: session.clientSessionId,
        redirectUri,
        codeChallenge: dto.code_challenge ?? null,
        // Omitted rather than set to null: Prisma's Json input rejects a bare
        // `null` (it means DbNull vs JsonNull), and an absent key is the column
        // default.
        ...(dto.dpop_jwk
          ? { dpopJwk: dto.dpop_jwk as unknown as Prisma.InputJsonValue }
          : {}),
        deviceLabel: dto.device_label ?? null,
        expiresAt,
      },
    });

    const authorizationUrl = new URL(
      `${this.pollar.sdkBase()}/auth/${dto.provider}`,
    );
    authorizationUrl.searchParams.set(
      'api_key',
      this.pollar.publishableKey(network),
    );
    authorizationUrl.searchParams.set(
      'client_session_id',
      session.clientSessionId,
    );
    authorizationUrl.searchParams.set('redirect_uri', callbackUrl);

    return {
      state,
      authorization_url: authorizationUrl.toString(),
      provider: dto.provider,
      redirect_uri: redirectUri,
      expires_at: expiresAt,
    };
  }

  // ── 2. The browser comes back ─────────────────────────────────────────────

  /**
   * The callback Pollar returns the user to. Public by necessity — it is a
   * browser navigation, carrying no API key and no gateway consumer.
   *
   * It does no Pollar work: it flips the handshake to `AUTHORIZED` and mints the
   * code. Everything expensive (waiting for Pollar to resolve and fund the
   * wallet, minting tokens) happens on the redemption call instead, where it is
   * authenticated, where a failure can be reported as JSON, and where the tokens
   * go straight out to the caller instead of needing somewhere to live.
   *
   * The state is unguessable and the transition is a compare-and-swap, so a
   * replayed callback URL finds nothing to do.
   */
  async handleCallback(state: string): Promise<PollarCallbackOutcome> {
    const session = await this.prisma.pollarOauthSession.findUnique({
      where: { state },
    });
    if (!session) {
      throw ApiError.notFound('Unknown Pollar authorization');
    }

    // A refreshed callback tab, or a replay. Send the browser on to the same
    // place, but without minting a second code for a handshake that has one.
    if (session.status !== PollarOauthStatus.PENDING) {
      return {
        redirectTo: session.redirectUri
          ? buildWalletRedirect(session.redirectUri, { state })
          : null,
        outcome: 'already_handled',
        state,
      };
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      await this.expire(session.id, 'BRIDGE_AUTHORIZATION_EXPIRED');
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'This Pollar authorization expired. Start a new login.',
      );
    }

    // Only a redirect-mode handshake mints its code here, because only it has
    // somewhere to put it. A poll-mode handshake just becomes redeemable: its
    // code is issued to the wallet's own authenticated poll instead of being
    // rendered into a browser page that the wallet does not control.
    const code = session.redirectUri ? mintCode() : null;
    const claimed = await this.prisma.pollarOauthSession.updateMany({
      where: { id: session.id, status: PollarOauthStatus.PENDING },
      data: {
        status: PollarOauthStatus.AUTHORIZED,
        ...(code
          ? {
              codeHash: hashCode(code),
              codeExpiresAt: this.codeDeadline(session.expiresAt),
            }
          : {}),
      },
    });
    if (claimed.count === 0) {
      // Another callback won the race and already claimed this handshake.
      return {
        redirectTo: session.redirectUri
          ? buildWalletRedirect(session.redirectUri, { state })
          : null,
        outcome: 'already_handled',
        state,
      };
    }

    return {
      redirectTo:
        session.redirectUri && code
          ? buildWalletRedirect(session.redirectUri, { code, state })
          : null,
      outcome: 'authorized',
      state,
    };
  }

  // ── 3. Redeem the code ────────────────────────────────────────────────────

  /**
   * Trades the single-use bridge code for a live Pollar session.
   *
   * The Pollar side of this is the slow part: after the provider callback,
   * Pollar still has to resolve or create the user's wallet, fund its reserve
   * and add the app's trustlines before the client session reports `READY`. So
   * the redemption waits (bounded by `POLLAR_LOGIN_WAIT_MS`) and only then calls
   * `/auth/login`.
   *
   * A failure in that window puts the handshake back to `AUTHORIZED` so the same
   * code can be retried until it expires — a dropped connection to Pollar should
   * not cost the user a second trip through a consent screen. A *terminal*
   * Pollar answer (the session is invalid or expired) is recorded as such,
   * because no amount of retrying will fix it.
   *
   * Once the session is live, the user is also registered on the *other* network
   * so they hold a wallet on both. That step is strictly best-effort and runs
   * after the handshake is already `CONSUMED`: see
   * {@link PollarWalletProvisioningService} for why it can never fail a login.
   */
  async exchange(
    consumer: GatewayConsumer,
    dto: ExchangeCodeDto,
  ): Promise<PollarSessionEntity> {
    const local = await this.consumers.resolve(consumer);
    const session = await this.claimCode(local.id, dto);

    try {
      await this.waitForReady(session);
      const login = await this.pollar.sdk<PollarLoginContent>(
        'POST',
        session.network as StellarNetwork,
        '/auth/login',
        {
          body: {
            clientSessionId: session.clientSessionId,
            ...(session.dpopJwk ? { dpopJwk: session.dpopJwk } : {}),
            ...(session.deviceLabel
              ? { deviceLabel: session.deviceLabel }
              : {}),
          },
        },
      );

      await this.prisma.pollarOauthSession.update({
        where: { id: session.id },
        data: {
          status: PollarOauthStatus.CONSUMED,
          // The code is spent; drop its hash so the unique index is free and
          // the row keeps nothing that could redeem anything.
          codeHash: null,
          codeExpiresAt: null,
          pollarUserId: login.userId,
          walletAddress: walletAddress(login.wallet),
          walletType: login.wallet?.type ?? null,
        },
      });

      // Both networks, best-effort. This runs after the handshake is CONSUMED
      // on purpose: the login has already succeeded by here, and provisioning
      // the other network must never be able to undo it.
      const networkWallets = await this.provisionQuietly(
        local.id,
        session,
        login,
      );

      return this.toSessionEntity(
        login,
        session.network as StellarNetwork,
        Boolean(session.dpopJwk),
        networkWallets,
      );
    } catch (err) {
      await this.releaseOrFail(session.id, err);
      throw this.toApiError(err, 'redeem');
    }
  }

  /**
   * Moves the handshake `AUTHORIZED -> EXCHANGING` and returns it, or explains
   * why it cannot. The status check and the claim are the same `updateMany`, so
   * two callers with the same code cannot both proceed.
   */
  private async claimCode(
    consumerId: string,
    dto: ExchangeCodeDto,
  ): Promise<PollarOauthSession> {
    const session = await this.prisma.pollarOauthSession.findUnique({
      where: { codeHash: hashCode(dto.code) },
    });
    // Unknown, spent, or another consumer's code: one answer for all three, so
    // the response cannot be used to probe which codes exist.
    if (!session || session.consumerId !== consumerId) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'Unknown or already redeemed authorization code',
      );
    }
    if (
      !session.codeExpiresAt ||
      session.codeExpiresAt.getTime() <= Date.now()
    ) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'This authorization code expired. Start a new login.',
      );
    }
    this.assertPkce(session, dto.code_verifier);

    const claimed = await this.prisma.pollarOauthSession.updateMany({
      where: { id: session.id, status: PollarOauthStatus.AUTHORIZED },
      data: { status: PollarOauthStatus.EXCHANGING },
    });
    if (claimed.count === 0) {
      throw ApiError.conflict(
        ApiErrorCode.OperationInFlight,
        'This authorization code is already being redeemed',
      );
    }
    return session;
  }

  /** PKCE is optional per handshake, but not negotiable once it was opened with one. */
  private assertPkce(
    session: PollarOauthSession,
    verifier: string | undefined,
  ): void {
    if (!session.codeChallenge) {
      if (verifier) {
        throw ApiError.badRequest(
          ApiErrorCode.ValidationFailed,
          'This authorization was opened without a code_challenge, so code_verifier is not accepted',
        );
      }
      return;
    }
    if (!verifier) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'code_verifier is required: this authorization was opened with a code_challenge',
      );
    }
    if (!verifyPkce(session.codeChallenge, verifier)) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'code_verifier does not match the code_challenge',
      );
    }
  }

  /**
   * Polls Pollar's client-session status until it reports `READY`.
   *
   * The SSE stream the browser SDK consumes buys nothing here — this is one
   * server-side wait on a request that is already blocking — so the one-shot
   * poll endpoint is the right transport, and it is the one Pollar publishes for
   * exactly this case (runtimes without response-body streaming).
   */
  private async waitForReady(session: PollarOauthSession): Promise<void> {
    const deadline = Date.now() + this.cfg.loginWaitMs;
    const path = this.sessionStatusPath(session);

    for (;;) {
      const status = await this.pollar.sdk<PollarSessionStatus>(
        'GET',
        session.network as StellarNetwork,
        path,
        // Never let one poll outlive the whole budget.
        { timeoutMs: Math.max(1_000, deadline - Date.now()) },
      );
      if (status.status === POLLAR_SESSION_READY) return;

      const remaining = deadline - Date.now();
      if (remaining <= POLLAR_SESSION_POLL_INTERVAL_MS) {
        throw ApiError.conflict(
          ApiErrorCode.OperationInFlight,
          'Pollar has not finished this login yet. Retry the same code shortly.',
        );
      }
      await sleep(POLLAR_SESSION_POLL_INTERVAL_MS);
    }
  }

  /**
   * Undoes the `EXCHANGING` claim after a failed redemption: back to
   * `AUTHORIZED` when the code is still worth retrying, terminal when Pollar
   * says the underlying session is gone for good.
   */
  private async releaseOrFail(id: string, err: unknown): Promise<void> {
    const terminal = isDeadClientSession(err);

    try {
      await this.prisma.pollarOauthSession.updateMany({
        where: { id, status: PollarOauthStatus.EXCHANGING },
        data: terminal
          ? {
              status: PollarOauthStatus.FAILED,
              codeHash: null,
              codeExpiresAt: null,
              errorCode:
                err instanceof PollarApiError ? err.code : 'LOGIN_FAILED',
            }
          : { status: PollarOauthStatus.AUTHORIZED },
      });
    } catch (release) {
      // The redemption already failed and its error is what the caller needs to
      // see; a failure to tidy up must not replace it. The sweeper expires the
      // row either way.
      this.logger.error(
        `Failed to release Pollar handshake ${id} after a failed redemption`,
        release as Error,
      );
    }
  }

  // ── 4. Poll (for wallets with nowhere to redirect) ────────────────────────

  /**
   * Reports where a handshake stands, and returns the code once it is ready.
   *
   * This is the flow for a wallet that cannot be addressed by URL: it opens the
   * authorization URL in the system browser and asks here whether the user came
   * back. The code travels over the consumer-authenticated API rather than a
   * browser redirect, which is the safer of the two hops — pair it with PKCE and
   * the code is useless to anyone but the wallet that asked for it.
   */
  async status(
    consumer: GatewayConsumer,
    state: string,
  ): Promise<PollarSessionStatusEntity> {
    const local = await this.consumers.resolve(consumer);
    const session = await this.prisma.pollarOauthSession.findUnique({
      where: { state },
    });
    if (!session || session.consumerId !== local.id) {
      throw ApiError.notFound('Unknown Pollar authorization');
    }

    if (
      session.status === PollarOauthStatus.PENDING &&
      session.expiresAt.getTime() <= Date.now()
    ) {
      await this.expire(session.id, 'BRIDGE_AUTHORIZATION_EXPIRED');
      return {
        status: PollarOauthStatus.EXPIRED.toLowerCase(),
        state,
        error_code: 'BRIDGE_AUTHORIZATION_EXPIRED',
      };
    }

    // Where a finished login is actually discovered: Pollar never navigates the
    // browser to the bridge callback, so nothing else would ever move this
    // handshake off PENDING.
    const current = await this.probeProvider(session);

    // The code is a bearer credential, so it only ever leaves here for a
    // handshake that has nowhere else to deliver it. A redirect-mode handshake
    // already handed its code to the wallet's redirect URI; issuing another
    // here would silently retire that one.
    const redeemable =
      current.status === PollarOauthStatus.AUTHORIZED &&
      current.redirectUri === null &&
      current.expiresAt.getTime() > Date.now();

    return {
      status: current.status.toLowerCase(),
      state,
      ...(redeemable ? await this.reissueCode(current) : {}),
      error_code: current.errorCode,
    };
  }

  /**
   * Asks Pollar whether the user has come back, and authorizes the handshake if
   * they have.
   *
   * **The callback is not a promise Pollar keeps.** Its hosted flow ends on
   * Pollar's own page either way: a refused consent redirects to
   * `www.pollar.xyz/auth/status?error=...`, and a successful one simply leaves
   * the client session `READY` — the `redirect_uri` the authorization URL
   * carries is never navigated to. Measured, not inferred: logins whose Pollar
   * session reported `READY` while this bridge still held the handshake
   * `PENDING` and had not been called back once, so each of them expired under a
   * wallet that was polling correctly.
   *
   * So the poll asks the provider instead of waiting to be told, and `READY` is
   * a safe thing to promote on because it is the very condition the redemption
   * already waits for — see {@link waitForReady}.
   *
   * Three things it deliberately does not do:
   *
   *   - **Serve redirect mode.** That handshake's code is delivered by the
   *     callback, and minting one here would retire it before the browser
   *     arrived.
   *   - **Throw.** A provider outage has to leave the login pending, not fail a
   *     poll the wallet repeats every few seconds.
   *   - **Ask on every poll.** {@link claimProbe} is a compare-and-swap, so
   *     concurrent polls — and replicas — make one request between them.
   */
  private async probeProvider(
    session: PollarOauthSession,
  ): Promise<PollarOauthSession> {
    if (
      session.status !== PollarOauthStatus.PENDING ||
      session.redirectUri !== null ||
      !(await this.claimProbe(session))
    ) {
      return session;
    }

    let status: PollarSessionStatus;
    try {
      status = await this.pollar.sdk<PollarSessionStatus>(
        'GET',
        session.network as StellarNetwork,
        this.sessionStatusPath(session),
        { timeoutMs: POLLAR_SESSION_PROBE_TIMEOUT_MS },
      );
    } catch (err) {
      // A session Pollar no longer knows can never become ready, and a wallet
      // polling one waits out the whole TTL for nothing.
      if (isDeadClientSession(err)) {
        return this.failHandshake(session, err);
      }
      this.logger.warn(
        `Could not ask Pollar about handshake ${session.state}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return session;
    }

    if (status.status !== POLLAR_SESSION_READY) return session;

    const claimed = await this.prisma.pollarOauthSession.updateMany({
      where: { id: session.id, status: PollarOauthStatus.PENDING },
      data: { status: PollarOauthStatus.AUTHORIZED },
    });
    if (claimed.count > 0) {
      return { ...session, status: PollarOauthStatus.AUTHORIZED };
    }
    // Lost the race to a callback or another poll — the same outcome by another
    // route, so read back what they wrote rather than report a stale PENDING.
    const fresh = await this.prisma.pollarOauthSession.findUnique({
      where: { id: session.id },
    });
    return fresh ?? session;
  }

  /**
   * Takes the right to ask Pollar about this handshake, at most once per
   * {@link POLLAR_SESSION_PROBE_INTERVAL_MS}.
   *
   * The stamp is written *before* the request and guarded by the value it
   * replaces, so two polls arriving together — on one replica or on several —
   * cannot both spend a provider request on the same question. Losing that swap
   * is not an error: the winner's answer reaches the caller on its next poll,
   * seconds away.
   */
  private async claimProbe(session: PollarOauthSession): Promise<boolean> {
    const now = Date.now();
    const last = session.providerCheckedAt;
    if (last && now - last.getTime() < POLLAR_SESSION_PROBE_INTERVAL_MS) {
      return false;
    }
    const claimed = await this.prisma.pollarOauthSession.updateMany({
      where: { id: session.id, providerCheckedAt: last },
      data: { providerCheckedAt: new Date(now) },
    });
    return claimed.count > 0;
  }

  /** Records a handshake Pollar has disowned, so the wallet stops polling it. */
  private async failHandshake(
    session: PollarOauthSession,
    err: unknown,
  ): Promise<PollarOauthSession> {
    const errorCode = err instanceof PollarApiError ? err.code : 'LOGIN_FAILED';
    await this.prisma.pollarOauthSession.updateMany({
      where: { id: session.id, status: PollarOauthStatus.PENDING },
      data: { status: PollarOauthStatus.FAILED, errorCode },
    });
    return { ...session, status: PollarOauthStatus.FAILED, errorCode };
  }

  /** The client-session status route, shared by the poll and the redemption. */
  private sessionStatusPath(session: PollarOauthSession): string {
    return `/auth/session/status/${encodeURIComponent(session.clientSessionId)}/poll`;
  }

  /**
   * Issues the poll flow a redeemable code.
   *
   * Nothing is read back, because nothing was stored: the row holds a hash, and
   * a hash cannot be un-hashed into a code. So each poll mints a fresh code and
   * swaps it in under the same compare-and-swap that guards every other
   * transition, which has a consequence worth stating plainly — **each poll
   * retires the previous code**, and a wallet redeems the one from its most
   * recent poll. That is the price of never storing a live credential, and it is
   * the right trade for a value that redeems a wallet session.
   */
  private async reissueCode(
    session: PollarOauthSession,
  ): Promise<{ code: string; code_expires_at: Date }> {
    const code = mintCode();
    const codeExpiresAt = this.codeDeadline(session.expiresAt);
    const swapped = await this.prisma.pollarOauthSession.updateMany({
      where: { id: session.id, status: PollarOauthStatus.AUTHORIZED },
      data: { codeHash: hashCode(code), codeExpiresAt },
    });
    if (swapped.count === 0) {
      // A redemption claimed the handshake between the read and this write.
      throw ApiError.conflict(
        ApiErrorCode.OperationInFlight,
        'This authorization is already being redeemed',
      );
    }
    return { code, code_expires_at: codeExpiresAt };
  }

  // ── 5. Session lifecycle passthrough ──────────────────────────────────────

  /**
   * Rotates a Pollar token pair.
   *
   * Refresh is unauthenticated at Pollar by design — the refresh token *is* the
   * credential and the access token must not be sent — so the bridge only adds
   * the publishable key. A DPoP-bound session cannot come through here at all:
   * its proof has to be signed by the wallet's private key over the wallet's own
   * request, and forging that from here is neither possible nor desirable.
   */
  async refresh(
    consumer: GatewayConsumer,
    dto: RefreshSessionDto,
  ): Promise<PollarTokenPairEntity> {
    const network = resolveNetwork(this.config, consumer);
    try {
      const refreshed = await this.pollar.sdk<PollarRefreshContent>(
        'POST',
        network,
        '/auth/refresh',
        { body: { refreshToken: dto.refresh_token } },
      );
      return {
        access_token: refreshed.token.accessToken,
        refresh_token: refreshed.token.refreshToken,
        token_type: 'Bearer',
        expires_at: refreshed.token.expiresAt,
      };
    } catch (err) {
      throw this.toApiError(err, 'refresh');
    }
  }

  /** Revokes the session behind an access token — this device, or all of them. */
  async logout(
    consumer: GatewayConsumer,
    dto: LogoutSessionDto,
  ): Promise<PollarLogoutEntity> {
    const network = resolveNetwork(this.config, consumer);
    try {
      const result = await this.pollar.sdk<PollarLogoutContent>(
        'POST',
        network,
        '/auth/logout',
        {
          accessToken: dto.access_token,
          body: { everywhere: dto.everywhere ?? false },
        },
      );
      return { revoked: result.revoked };
    } catch (err) {
      throw this.toApiError(err, 'logout');
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * When a freshly minted code stops being redeemable: its own short TTL, but
   * never past the handshake's deadline. Without the clamp, a code issued in the
   * last seconds of a handshake would outlive the row the sweeper is about to
   * expire, and would fail at redemption for a reason the wallet cannot see.
   */
  private codeDeadline(handshakeExpiresAt: Date): Date {
    return new Date(
      Math.min(Date.now() + this.cfg.codeTtlMs, handshakeExpiresAt.getTime()),
    );
  }

  private async expire(id: string, errorCode: string): Promise<void> {
    await this.prisma.pollarOauthSession.updateMany({
      where: {
        id,
        status: {
          in: [PollarOauthStatus.PENDING, PollarOauthStatus.AUTHORIZED],
        },
      },
      data: {
        status: PollarOauthStatus.EXPIRED,
        codeHash: null,
        codeExpiresAt: null,
        errorCode,
      },
    });
  }

  /**
   * Gets the user a wallet on both networks, with a second belt around it.
   *
   * {@link PollarWalletProvisioningService} is written never to reject — a
   * wallet it could not create comes back `pending`. This catch is for the day
   * that contract breaks anyway: by the time it runs, the tokens are minted and
   * the code is spent, so an exception escaping here costs the user a login they
   * cannot retry and a second trip through a consent screen. One try/catch is a
   * cheap price for never doing that.
   */
  private async provisionQuietly(
    consumerId: string,
    session: PollarOauthSession,
    login: PollarLoginContent,
  ): Promise<PollarNetworkWalletEntity[]> {
    const network = session.network as StellarNetwork;
    try {
      return await this.provisioning.provisionBothNetworks({
        consumerId,
        // Trimmed to null rather than passed through: an empty string is not a
        // handle Pollar can resolve anyone by.
        externalId: login.data?.mail?.trim() || null,
        primaryNetwork: network,
        wallet: login.wallet,
        pollarUserId: login.userId,
        profile: {
          first_name: login.data?.first_name,
          last_name: login.data?.last_name,
          avatar: login.data?.avatar,
        },
      });
    } catch (err) {
      this.logger.error(
        'Cross-network Pollar provisioning failed outright; reporting the login wallet only',
        err as Error,
      );
      const address = walletAddress(login.wallet);
      return [{ network, status: address ? 'ready' : 'pending', address }];
    }
  }

  private toSessionEntity(
    login: PollarLoginContent,
    network: StellarNetwork,
    dpopBound: boolean,
    networkWallets: PollarNetworkWalletEntity[],
  ): PollarSessionEntity {
    return {
      access_token: login.token.accessToken,
      refresh_token: login.token.refreshToken,
      token_type: dpopBound ? 'DPoP' : 'Bearer',
      expires_at: login.token.expiresAt,
      user_id: login.userId,
      wallet: toPollarWalletEntity(login.wallet),
      wallets: (login.wallets?.length ? login.wallets : [login.wallet])
        .filter((wallet): wallet is PollarWallet => Boolean(wallet))
        .map(toPollarWalletEntity),
      profile: {
        email: login.data?.mail,
        first_name: login.data?.first_name,
        last_name: login.data?.last_name,
        avatar: login.data?.avatar,
      },
      network_wallets: networkWallets,
      publishable_key: this.pollar.publishableKey(network),
      api_base_url: this.pollar.sdkBase(),
    };
  }

  /**
   * Maps a Pollar failure onto this API's envelope. Pollar's `code` is the part
   * an integrator branches on, so it is relayed in the message; a 4xx keeps its
   * class (the caller's token really is expired) while a 5xx collapses to 502,
   * which is what it is from here.
   */
  private toApiError(err: unknown, action: string): Error {
    if (!(err instanceof PollarApiError)) {
      return err instanceof Error ? err : new Error(String(err));
    }
    this.logger.warn(`Pollar ${action} rejected: ${err.code}`);
    if (err.status === 401 || err.status === 403) {
      return new ApiError(
        err.status,
        ApiErrorCode.ProviderError,
        `Pollar rejected the session (${err.code})`,
      );
    }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a Pollar failure means the client session behind a handshake is gone
 * for good rather than merely unreachable.
 *
 * Shared by the poll and the redemption because both have the same decision to
 * make from it: retrying costs a request and can never succeed, so the handshake
 * becomes terminal instead of waiting out its budget.
 */
function isDeadClientSession(err: unknown): boolean {
  return (
    err instanceof PollarApiError &&
    (POLLAR_TERMINAL_SESSION_CODES.has(err.code) ||
      err.status === 404 ||
      err.status === 410)
  );
}
