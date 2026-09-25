import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WalletAuthHandshakeStatus,
  WalletAuthMethod,
  WalletAuthProvider,
  WalletLoginCodeStatus,
} from '@generated/prisma/client';
import { AppConfig } from '@/config/configuration';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { PrismaService } from '@/prisma/prisma.service';
import {
  HANDSHAKE_TTL_MS,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_RESEND_MS,
  LOGIN_CODE_TTL_MS,
  SESSION_TTL_MS,
} from '@/wallet-auth/wallet-auth.constants';
import {
  PROVIDER_ENDPOINTS,
  PROVIDER_WIRE,
  authorizationUrl,
  backupMessage,
  callbackUrl,
  fallbackName,
  finishMessage,
  githubIdentity,
  googleIdentity,
  isBackupBox,
  issueSessionToken,
  methodOfProvider,
  normalizeEmail,
  pkceMatches,
  providerFromWire,
  randomToken,
  readSessionToken,
  sha256Hex,
  signedAtFresh,
  sixDigitCode,
  verifyWalletSignature,
  type IdentityResult,
  type ProviderIdentity,
  type WalletAuthIdentity,
} from '@/wallet-auth/wallet-auth-core';
import {
  ClaimWalletOauthDto,
  FinishWalletSignInDto,
  ReplaceWalletBackupDto,
  StartWalletEmailDto,
  StartWalletOauthDto,
  VerifyWalletEmailDto,
} from '@/wallet-auth/dto/wallet-auth.dto';

/** What the callback route needs to render a page for the person. */
export interface CallbackOutcome {
  ok: boolean;
  /** A token the page maps to a sentence. Never prose. */
  reason:
    | 'ok'
    | 'expired'
    | 'denied'
    | 'email_unverified'
    | 'profile_invalid'
    | 'failed';
}

/**
 * The wallet's own sign-in: Google, GitHub or an emailed code — and the key
 * stays on the device.
 *
 * ## What this is, and what it is not
 *
 * A sign-in here proves WHO someone is. It never touches a key: a new wallet
 * generates its seed on the device and seals it under the person's password, and
 * this service is handed the sealed box. A sign-in on the next device gets the
 * box back; only the password opens it, and the password never arrives here. So
 * two different questions are answered by two different parties — "who is this"
 * by a provider or a mailbox, "may they have the wallet" by the password.
 *
 * ## How an email is trusted
 *
 *  - A provider's VERIFIED email is enough to create a NEW account. The
 *    authorization URL works in anyone's browser, so a stranger can start a
 *    sign-in and send someone the link; for an email with no account that buys
 *    them an empty account they could squat, never a wallet with money in it.
 *  - An email that ALREADY has an account gets nothing on the provider's word. A
 *    code goes to that inbox and only the code finishes the sign-in. Whoever
 *    consented reads the inbox; a stranger who sent them the link does not. That
 *    is also the only door to an existing backup, which is the thing worth
 *    stealing.
 *  - An email sign-in is the inbox proof itself, so it needs nothing else.
 *
 * ## The three steps, and what each hands out
 *
 *  1. Prove the email — `startOauth` / `handleCallback` / `claimOauth`, or
 *     `startEmail` / `verifyEmail`. Ends in `ready`: the identity, whether an
 *     account exists, the backup if there is one, and a short-lived session
 *     token. No credential yet.
 *  2. `finish` — the session token plus a signature by the Stellar key the
 *     device now holds. Creates or links the account and stores the backup.
 *  3. Later, `replaceBackupBox` — the device re-seals the box under a new
 *     password. No sign-in: the signature by the backup's own key is the
 *     credential.
 *
 * The signature in step 2 is what binds the account to a KEY rather than to
 * whoever holds a session token. The token proves an email; the signature proves
 * the device holds the address the account is being attached to.
 *
 * Ported from the developer platform's `src/lib/wallet-auth.ts`. The wire
 * contract is identical on purpose — the wallet changes a base URL, nothing
 * else.
 */
@Injectable()
export class WalletAuthService {
  private readonly logger = new Logger(WalletAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private get settings() {
    return this.config.get('walletAuth', { infer: true });
  }

  /* ------------------------------- providers ------------------------------ */

  /** Credentials for one provider, or null when this deployment has none. */
  private credentials(
    provider: WalletAuthProvider,
  ): { clientId: string; clientSecret: string } | null {
    const pair =
      provider === WalletAuthProvider.GOOGLE
        ? this.settings.google
        : this.settings.github;
    return pair.clientId && pair.clientSecret ? pair : null;
  }

  /**
   * Which doors this deployment actually has.
   *
   * Reported rather than assumed, so a wallet renders the buttons that work. A
   * compiled-in list is how a self-hosted deployment with no Google credentials
   * shows a Google button that dies at the consent screen.
   */
  providers(): { providers: string[]; email: boolean } {
    const available = (
      [WalletAuthProvider.GOOGLE, WalletAuthProvider.GITHUB] as const
    )
      .filter((p) => this.credentials(p) !== null)
      .map((p) => PROVIDER_WIRE[p]);
    return { providers: available, email: this.emailAvailable() };
  }

  /** The email door needs somewhere to hand the code to. */
  private emailAvailable(): boolean {
    return Boolean(this.settings.consoleUrl);
  }

  /* --------------------------------- OAuth -------------------------------- */

  /**
   * Open a handshake and hand back the URL to put in a browser.
   *
   * Nothing is reserved by this: a handshake is a row and a URL. The `state` is
   * random and unique, and it is the only thing that travels through the
   * browser — the verifier behind `codeChallenge` stays on the device and is
   * what redemption actually requires.
   */
  async startOauth(dto: StartWalletOauthDto) {
    const provider = providerFromWire(dto.provider);
    if (!provider) {
      throw ApiError.badRequest(
        ApiErrorCode.WalletProviderUnavailable,
        `Unknown provider: ${dto.provider}`,
      );
    }

    const creds = this.credentials(provider);
    if (!creds) {
      throw ApiError.unavailable(
        ApiErrorCode.WalletProviderUnavailable,
        `${PROVIDER_WIRE[provider]} sign-in is not configured on this deployment.`,
      );
    }
    const baseUrl = this.requireBaseUrl();

    const state = randomToken();
    const expiresAt = new Date(Date.now() + HANDSHAKE_TTL_MS);

    await this.prisma.walletAuthHandshake.create({
      data: {
        state,
        provider,
        codeChallenge: dto.codeChallenge,
        status: WalletAuthHandshakeStatus.PENDING,
        expiresAt,
      },
    });

    return {
      state,
      authorizationUrl: authorizationUrl(provider, {
        clientId: creds.clientId,
        redirectUri: callbackUrl(baseUrl, provider),
        state,
      }),
      expiresAt,
    };
  }

  /**
   * Where the provider returns the browser.
   *
   * Everything this learns is written to the handshake row; nothing is handed to
   * the browser but a page. The device collects the identity by presenting the
   * verifier, which the browser never had.
   */
  async handleCallback(
    providerWire: string,
    params: { code?: string; state?: string; error?: string },
  ): Promise<CallbackOutcome> {
    const provider = providerFromWire(providerWire);
    const state = params.state?.trim();
    if (!provider || !state) return { ok: false, reason: 'expired' };

    const handshake = await this.prisma.walletAuthHandshake.findUnique({
      where: { state },
    });
    // A handshake that is not PENDING has already been answered, and answering
    // it twice is how a second callback overwrites the first one's identity.
    if (
      !handshake ||
      handshake.provider !== provider ||
      handshake.status !== WalletAuthHandshakeStatus.PENDING ||
      handshake.expiresAt.getTime() < Date.now()
    ) {
      return { ok: false, reason: 'expired' };
    }

    if (params.error || !params.code) {
      await this.failHandshake(state, 'denied');
      return { ok: false, reason: 'denied' };
    }

    let identity: IdentityResult;
    try {
      identity = await this.readIdentity(provider, params.code);
    } catch (error) {
      this.logger.warn(
        `wallet sign-in: ${PROVIDER_WIRE[provider]} exchange failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.failHandshake(state, 'failed');
      return { ok: false, reason: 'failed' };
    }

    if (!identity.ok) {
      await this.failHandshake(state, identity.error);
      return { ok: false, reason: identity.error };
    }

    await this.prisma.walletAuthHandshake.update({
      where: { state },
      data: {
        status: WalletAuthHandshakeStatus.AUTHORIZED,
        email: identity.identity.email,
        name: identity.identity.name,
        avatar: identity.identity.avatar,
        subject: identity.identity.subject,
      },
    });
    return { ok: true, reason: 'ok' };
  }

  private async failHandshake(state: string, failure: string): Promise<void> {
    await this.prisma.walletAuthHandshake.update({
      where: { state },
      data: { status: WalletAuthHandshakeStatus.FAILED, failure },
    });
  }

  /**
   * Where a handshake is.
   *
   * Answers on the `state` alone, which is deliberate: polling is all a `state`
   * buys. The identity is not in this response at any status.
   */
  async pollStatus(state: string) {
    const handshake = await this.prisma.walletAuthHandshake.findUnique({
      where: { state },
      select: { status: true, failure: true, expiresAt: true },
    });
    if (!handshake) return { status: 'expired' as const };

    if (
      handshake.status === WalletAuthHandshakeStatus.PENDING &&
      handshake.expiresAt.getTime() < Date.now()
    ) {
      return { status: 'expired' as const };
    }

    switch (handshake.status) {
      case WalletAuthHandshakeStatus.PENDING:
        return { status: 'pending' as const };
      case WalletAuthHandshakeStatus.AUTHORIZED:
        return { status: 'authorized' as const };
      case WalletAuthHandshakeStatus.REDEEMED:
        return { status: 'redeemed' as const };
      case WalletAuthHandshakeStatus.FAILED:
        return {
          status: 'failed' as const,
          error: handshake.failure ?? 'failed',
        };
      default:
        return { status: 'expired' as const };
    }
  }

  /**
   * Redeem a handshake with the verifier the device kept.
   *
   * The fork that matters is at the end: a NEW email gets a session token here,
   * and an email that already has an account gets a code in its inbox instead.
   */
  async claimOauth(dto: ClaimWalletOauthDto) {
    const handshake = await this.prisma.walletAuthHandshake.findUnique({
      where: { state: dto.state },
    });
    if (!handshake) return { status: 'expired' as const };

    if (handshake.status === WalletAuthHandshakeStatus.PENDING) {
      return handshake.expiresAt.getTime() < Date.now()
        ? { status: 'expired' as const }
        : { status: 'pending' as const };
    }
    if (handshake.status === WalletAuthHandshakeStatus.FAILED) {
      return {
        status: 'failed' as const,
        error: handshake.failure ?? 'failed',
      };
    }
    if (handshake.status !== WalletAuthHandshakeStatus.AUTHORIZED) {
      // REDEEMED or EXPIRED. Both are "start again", and saying which would let
      // a caller learn that a `state` it does not own was used.
      return { status: 'expired' as const };
    }

    if (!pkceMatches(dto.codeVerifier, handshake.codeChallenge)) {
      throw ApiError.badRequest(
        ApiErrorCode.WalletVerifierInvalid,
        'The verifier does not match this handshake.',
      );
    }

    // Single-shot: burn it before anything is handed back, so two concurrent
    // redemptions cannot both succeed.
    const burned = await this.prisma.walletAuthHandshake.updateMany({
      where: { state: dto.state, status: WalletAuthHandshakeStatus.AUTHORIZED },
      data: { status: WalletAuthHandshakeStatus.REDEEMED },
    });
    if (burned.count !== 1) return { status: 'expired' as const };

    const email = normalizeEmail(handshake.email ?? '');
    if (!email) return { status: 'failed' as const, error: 'profile_invalid' };

    const identity: WalletAuthIdentity = {
      email,
      name: handshake.name,
      avatar: handshake.avatar,
      method: methodOfProvider(handshake.provider),
    };

    const account = await this.prisma.walletAccount.findUnique({
      where: { email },
      include: { backup: true },
    });

    // An existing account is where the backup worth stealing is, so the
    // provider's word is not enough for it.
    if (account) {
      const sent = await this.mintLoginCode(identity);
      return {
        status: 'verify_email' as const,
        claimToken: sent.claimToken,
        expiresInSeconds: sent.expiresInSeconds,
        email,
      };
    }

    return this.readyPayload(identity, null);
  }

  /* --------------------------------- email -------------------------------- */

  /** Start an email sign-in: a code to the mailbox, a claim token to the device. */
  async startEmail(dto: StartWalletEmailDto) {
    const email = normalizeEmail(dto.email);

    // The cooldown is on the ROW, not only on the route budget: the route is
    // keyed by consumer plus client address, and the thing being protected is
    // somebody else's inbox. Rotating an address must not buy another email.
    const recent = await this.prisma.walletLoginCode.findFirst({
      where: {
        email,
        status: WalletLoginCodeStatus.PENDING,
        sentAt: { gt: new Date(Date.now() - LOGIN_CODE_RESEND_MS) },
      },
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true },
    });
    if (recent) {
      throw ApiError.badRequest(
        ApiErrorCode.WalletLoginCodeCooldown,
        'A code was just sent to that address. Wait a moment before asking for another.',
      );
    }

    const existing = await this.prisma.walletAccount.findUnique({
      where: { email },
      select: { name: true, avatar: true },
    });

    const sent = await this.mintLoginCode({
      email,
      name: existing?.name ?? null,
      avatar: existing?.avatar ?? null,
      method: WalletAuthMethod.EMAIL,
    });
    return {
      claimToken: sent.claimToken,
      expiresInSeconds: sent.expiresInSeconds,
    };
  }

  /**
   * Mint a code, store only its hash, and hand it to whatever delivers mail.
   *
   * The raw code never lands in the database, and the raw claim token never does
   * either — the row holds SHA-256 of each. A dump of this table lets nobody
   * finish a sign-in.
   */
  private async mintLoginCode(identity: WalletAuthIdentity) {
    const claimToken = randomToken();
    const code = sixDigitCode();
    const expiresAt = new Date(Date.now() + LOGIN_CODE_TTL_MS);

    await this.prisma.walletLoginCode.create({
      data: {
        email: identity.email,
        name: identity.name,
        avatar: identity.avatar,
        via: identity.method,
        claimHash: sha256Hex(claimToken),
        codeHash: sha256Hex(code),
        status: WalletLoginCodeStatus.PENDING,
        expiresAt,
      },
    });

    await this.deliverCode(identity.email, identity.name, code, expiresAt);

    return {
      claimToken,
      expiresInSeconds: Math.floor(LOGIN_CODE_TTL_MS / 1000),
    };
  }

  /**
   * Answer a code.
   *
   * The attempt is counted BEFORE the comparison and as part of the same
   * conditional update, so concurrent guesses cannot both read a clean counter.
   */
  async verifyEmail(dto: VerifyWalletEmailDto) {
    const row = await this.prisma.walletLoginCode.findUnique({
      where: { claimHash: sha256Hex(dto.claimToken) },
    });
    if (!row) return { status: 'expired' as const };
    if (row.status === WalletLoginCodeStatus.LOCKED) {
      return { status: 'locked' as const };
    }
    if (
      row.status !== WalletLoginCodeStatus.PENDING ||
      row.expiresAt.getTime() < Date.now()
    ) {
      return { status: 'expired' as const };
    }

    const attempts = row.attempts + 1;
    const correct = sha256Hex(dto.code) === row.codeHash;

    if (!correct) {
      const locked = attempts >= LOGIN_CODE_MAX_ATTEMPTS;
      await this.prisma.walletLoginCode.update({
        where: { id: row.id },
        data: {
          attempts,
          status: locked
            ? WalletLoginCodeStatus.LOCKED
            : WalletLoginCodeStatus.PENDING,
        },
      });
      return locked
        ? { status: 'locked' as const }
        : {
            status: 'invalid' as const,
            attemptsLeft: LOGIN_CODE_MAX_ATTEMPTS - attempts,
          };
    }

    // Single-shot, for the same reason the handshake is.
    const claimed = await this.prisma.walletLoginCode.updateMany({
      where: { id: row.id, status: WalletLoginCodeStatus.PENDING },
      data: { attempts, status: WalletLoginCodeStatus.CLAIMED },
    });
    if (claimed.count !== 1) return { status: 'expired' as const };

    const identity: WalletAuthIdentity = {
      email: row.email,
      name: row.name,
      avatar: row.avatar,
      method: row.via,
    };
    const account = await this.prisma.walletAccount.findUnique({
      where: { email: row.email },
      include: { backup: true },
    });
    return this.readyPayload(identity, account);
  }

  /* --------------------------------- ready -------------------------------- */

  /** What a proven email is worth: an identity, the backup if any, and a token. */
  private readyPayload(
    identity: WalletAuthIdentity,
    account: {
      id: string;
      stellarAddress: string;
      backup: { stellarAddress: string; box: string; updatedAt: Date } | null;
    } | null,
  ) {
    return {
      status: 'ready' as const,
      identity: {
        email: identity.email,
        name: identity.name,
        avatar: identity.avatar,
        method: identity.method.toLowerCase(),
      },
      // A marker, not an id. The wallet types this field `'existing' | 'new'`
      // and branches its onboarding on it — a cuid here would read as truthy
      // prose and take the wrong branch in silence.
      account: account ? ('existing' as const) : ('new' as const),
      backup: account?.backup
        ? {
            stellarAddress: account.backup.stellarAddress,
            box: account.backup.box,
            updatedAt: account.backup.updatedAt.toISOString(),
          }
        : null,
      sessionToken: issueSessionToken(identity, this.requireSessionSecret()),
      expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000),
    };
  }

  /* --------------------------------- finish ------------------------------- */

  /**
   * Attach the identity to the address whose key this device holds.
   *
   * The session token proves an email. The signature proves the device holds the
   * address. Neither alone creates anything: a token without a signature is a
   * claim about a mailbox with no key behind it, and a signature without a token
   * is a key with no proven owner.
   */
  async finish(sessionToken: string, dto: FinishWalletSignInDto) {
    const identity = readSessionToken(
      sessionToken,
      this.requireSessionSecret(),
    );
    if (!identity) {
      throw ApiError.unauthorized(
        ApiErrorCode.WalletSessionInvalid,
        'This sign-in has expired. Start again.',
      );
    }

    if (!signedAtFresh(dto.signedAt)) {
      throw ApiError.badRequest(
        ApiErrorCode.WalletSignatureInvalid,
        'The signed timestamp is outside the accepted window.',
      );
    }
    const message = finishMessage(
      identity.email,
      dto.stellarAddress,
      dto.signedAt,
    );
    if (!verifyWalletSignature(dto.stellarAddress, message, dto.signature)) {
      throw ApiError.badRequest(
        ApiErrorCode.WalletSignatureInvalid,
        'The signature does not verify against that account.',
      );
    }

    if (dto.backup !== undefined && !isBackupBox(dto.backup)) {
      throw ApiError.badRequest(
        ApiErrorCode.WalletBackupInvalid,
        'That is not a backup box this service will keep.',
      );
    }

    const existing = await this.prisma.walletAccount.findUnique({
      where: { email: identity.email },
      include: { backup: true },
    });

    // Refusing here rather than overwriting is the whole point. The box being
    // discarded may be the only copy of a funded wallet, and the wallet asks the
    // person to acknowledge that before it ever sets `replaceBackup`.
    if (
      existing?.backup &&
      existing.backup.stellarAddress !== dto.stellarAddress &&
      !dto.replaceBackup
    ) {
      return {
        status: 'backup_conflict' as const,
        stellarAddress: existing.backup.stellarAddress,
      };
    }

    const name = fallbackName(identity.email, identity.name);
    const account = await this.prisma.walletAccount.upsert({
      where: { email: identity.email },
      create: {
        email: identity.email,
        name,
        avatar: identity.avatar,
        method: identity.method,
        stellarAddress: dto.stellarAddress,
      },
      update: {
        name,
        avatar: identity.avatar,
        method: identity.method,
        stellarAddress: dto.stellarAddress,
      },
    });

    if (dto.backup !== undefined) {
      await this.prisma.walletBackup.upsert({
        where: { walletAccountId: account.id },
        create: {
          walletAccountId: account.id,
          stellarAddress: dto.stellarAddress,
          box: dto.backup,
        },
        update: { stellarAddress: dto.stellarAddress, box: dto.backup },
      });
    }

    const keys = await this.provisionKeys({
      accountId: account.id,
      stellarAddress: dto.stellarAddress,
      email: identity.email,
      name,
    });

    return {
      status: 'ready' as const,
      // Again a marker, and a different vocabulary from the one `ready` uses:
      // the wallet types this one `'created' | 'linked'`.
      account: existing ? ('linked' as const) : ('created' as const),
      organizationId: keys.organizationId,
      keys: { dev: keys.dev, prod: keys.prod },
    };
  }

  /* --------------------------------- backup ------------------------------- */

  /**
   * Store a re-sealed box. No sign-in: the signature by the box's own address is
   * the credential, and the challenge covers the box's hash so one signature
   * stores exactly one box.
   */
  async replaceBackupBox(dto: ReplaceWalletBackupDto) {
    if (!signedAtFresh(dto.signedAt)) {
      throw ApiError.badRequest(
        ApiErrorCode.WalletSignatureInvalid,
        'The signed timestamp is outside the accepted window.',
      );
    }
    if (!isBackupBox(dto.box)) {
      throw ApiError.badRequest(
        ApiErrorCode.WalletBackupInvalid,
        'That is not a backup box this service will keep.',
      );
    }
    const message = backupMessage(dto.stellarAddress, dto.box, dto.signedAt);
    if (!verifyWalletSignature(dto.stellarAddress, message, dto.signature)) {
      throw ApiError.badRequest(
        ApiErrorCode.WalletSignatureInvalid,
        'The signature does not verify against that account.',
      );
    }

    // Scoped to the address that signed, which is what makes the signature the
    // credential: a valid signature by A can only ever move A's own box.
    const backup = await this.prisma.walletBackup.findFirst({
      where: { stellarAddress: dto.stellarAddress },
      select: { id: true },
    });
    if (!backup) {
      throw ApiError.notFound(
        'No backup is stored for that account.',
        ApiErrorCode.WalletAccountMismatch,
      );
    }

    const updated = await this.prisma.walletBackup.update({
      where: { id: backup.id },
      data: { box: dto.box },
      select: { stellarAddress: true, updatedAt: true },
    });
    return { status: 'ok' as const, ...updated };
  }

  /* ------------------------------ provider I/O ---------------------------- */

  /** Exchange the code and read who the person is. Throws on any transport failure. */
  private async readIdentity(
    provider: WalletAuthProvider,
    code: string,
  ): Promise<IdentityResult> {
    const creds = this.credentials(provider);
    if (!creds) return { ok: false, error: 'profile_invalid' };
    const ep = PROVIDER_ENDPOINTS[provider];

    const token = await this.exchangeCode(provider, code, creds);
    const profile = await this.getJson(ep.profile, token);

    if (provider === WalletAuthProvider.GOOGLE) return googleIdentity(profile);
    const emails = await this.getJson(ep.emails as string, token);
    return githubIdentity(profile, emails);
  }

  private async exchangeCode(
    provider: WalletAuthProvider,
    code: string,
    creds: { clientId: string; clientSecret: string },
  ): Promise<string> {
    const ep = PROVIDER_ENDPOINTS[provider];
    const body = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: callbackUrl(this.requireBaseUrl(), provider),
    });

    const res = await fetch(ep.token, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // GitHub answers form-encoded unless asked otherwise, and a silently
        // form-encoded body parsed as JSON reads as "no access token".
        accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(this.settings.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`token exchange answered ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: unknown };
    const token =
      typeof json.access_token === 'string' ? json.access_token : null;
    if (!token) throw new Error('token exchange returned no access token');
    return token;
  }

  private async getJson(url: string, accessToken: string): Promise<unknown> {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        // GitHub rejects a request with no user agent.
        'user-agent': 'cosmos-pay-community-server',
      },
      signal: AbortSignal.timeout(this.settings.timeoutMs),
    });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.json();
  }

  /* ------------------------------ console hops ---------------------------- */

  /**
   * Hand the code to whatever sends mail.
   *
   * This service deliberately owns no mailer. It mints the code and posts it to
   * the operator's console, which delivers it — the same split `ConsoleOnlyGuard`
   * already makes for alias recovery, in the other direction. A self-hosted
   * deployment points `WALLET_AUTH_CONSOLE_URL` at its own sender and owes this
   * service nothing else.
   *
   * A failure here is a failure of the whole call, not a warning: a code minted
   * and never delivered is a person staring at an empty inbox with a live row
   * holding down their resend cooldown.
   */
  private async deliverCode(
    email: string,
    name: string | null,
    code: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.postToConsole('/wallet-auth/login-code', {
      email,
      name,
      code,
      expiresAt: expiresAt.toISOString(),
    });
  }

  /**
   * Ask the console to mint this account's gateway credentials.
   *
   * Key minting needs APISIX admin, and this service deliberately does not hold
   * it: everything registered here is something an attacker who reached this
   * process could also call, and "mint a credential for any consumer" is not on
   * that list. The console already holds admin for the dashboard's own key
   * management, so the capability lives in one place rather than two.
   */
  private async provisionKeys(input: {
    accountId: string;
    stellarAddress: string;
    email: string;
    name: string;
  }): Promise<{
    organizationId: string;
    dev: string | null;
    prod: string | null;
  }> {
    const answer = (await this.postToConsole(
      '/wallet-auth/provision',
      input,
    )) as {
      organizationId?: unknown;
      keys?: { dev?: unknown; prod?: unknown };
    };

    const str = (v: unknown): string | null =>
      typeof v === 'string' && v ? v : null;
    return {
      organizationId: str(answer.organizationId) ?? '',
      dev: str(answer.keys?.dev),
      prod: str(answer.keys?.prod),
    };
  }

  private async postToConsole(path: string, body: unknown): Promise<unknown> {
    const base = this.settings.consoleUrl;
    if (!base) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'This deployment has no console configured to complete a sign-in.',
      );
    }
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The same marker APISIX strips from everything it proxies, which is
        // what makes it proof of a backend-to-backend call.
        'x-cosmos-internal': '1',
        'x-gateway-secret': this.settings.consoleSecret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.settings.timeoutMs),
    });
    if (!res.ok) {
      this.logger.error(
        `wallet sign-in: console ${path} answered ${res.status}`,
      );
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'The sign-in could not be completed. Try again shortly.',
      );
    }
    return res.json().catch(() => ({}));
  }

  /* -------------------------------- config -------------------------------- */

  private requireBaseUrl(): string {
    const base = this.settings.publicBaseUrl;
    if (!base) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'WALLET_AUTH_PUBLIC_BASE_URL is not set, so no redirect URI can be built.',
      );
    }
    return base;
  }

  private requireSessionSecret(): string {
    const secret = this.settings.sessionSecret;
    if (!secret) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'No session secret is configured, so no sign-in token can be sealed.',
      );
    }
    return secret;
  }
}

/** Re-exported for the controller's page rendering. */
export type { ProviderIdentity };
