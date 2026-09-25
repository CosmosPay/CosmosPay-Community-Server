import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FeeBumpTransaction,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { RecoveryEmailCodeStatus } from '@generated/prisma/client';
import { OidcService } from '@/common/oidc/oidc.service';
import { isUniqueViolation } from '@/common/prisma-errors';
import { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { fetchAccountSigners, isAccountId } from '@/stellar/account-signers';
import {
  randomToken,
  sha256Hex,
  sixDigitCode,
} from '@/wallet-auth/wallet-auth-core';
import {
  actorFromToken,
  authenticatesAs,
  buildStellarToml,
  IDENTITY_ROLES,
  issueIdentityToken,
  issueSep10Token,
  listWhere,
  mayAct,
  networkOf,
  normalizeEmail,
  signerFor,
  signRefusal,
  type AccountResponse,
  type Actor,
  type Identity,
  type IdentityRole,
  type RecoveryRules,
} from '@/recovery/recovery-core';
import {
  buildChallenge,
  readChallenge,
  verifyChallenge,
} from '@/recovery/sep10-core';
import {
  IDENTITY_TOKEN_TTL_S,
  OIDC_MAX_LOGIN_AGE_S,
  RECOVERY_CODE_DAILY_CAP,
  RECOVERY_CODE_MAX_ATTEMPTS,
  RECOVERY_CODE_RESEND_MS,
  RECOVERY_CODE_TTL_MS,
  RECOVERY_PAGE_SIZE,
} from '@/recovery/recovery.constants';

/**
 * A SEP error: `{ "error": "..." }` with a status, and nothing else.
 *
 * SEP-10 and SEP-30 are endpoints someone else's client calls, so they answer in
 * the standard's shape rather than this API's envelope — `SepExceptionFilter`
 * renders these. The message is for a human reading a log; the status is the
 * contract, and no client should branch on the text.
 */
export class SepError extends HttpException {
  constructor(message: string, status: number) {
    super({ error: message }, status);
  }
}

const notFound = () => new SepError('Not found.', HttpStatus.NOT_FOUND);
const unauthorized = () =>
  new SepError(
    'No token, or a token for another server.',
    HttpStatus.UNAUTHORIZED,
  );
const notTheKeyHolder = () =>
  new SepError("This needs the account's own key.", HttpStatus.FORBIDDEN);

/** The row shape the account routes read. */
type AccountRow = {
  id: string;
  address: string;
  createdAt: Date;
  methods: { identityRole: string; type: string; value: string }[];
};

/**
 * SEP-10 + SEP-30, from one of the two recovery servers — the storage and the
 * network, wired to the rules in `recovery-core.ts` and `sep10-core.ts`.
 *
 * ## How an inbox is proven here, and why neither way trusts the other server
 *
 * Someone who lost their device has no key, so the credential they recover with
 * is an identity. This server accepts it two ways, and in both it checks the
 * proof ITSELF:
 *
 *  - **An OIDC ID token** (`exchangeIdToken`) — Authentik's, verified against the
 *    provider's published keys. Nothing here can mint one, and the sibling server
 *    verifies the same token on its own. Each server takes a given token once.
 *  - **Its own emailed code** (`startEmail` / `verifyEmail`), for a deployment
 *    with no provider. The code is minted and checked here; the other server
 *    sends its own. Only as independent as the two mail paths are — point each
 *    server's `RECOVERY_EMAIL_DELIVERY_URL` at its own sender for that.
 *
 * What replaced both was an identity token minted in exchange for a SIGN-IN
 * session, verified with an HMAC secret that the sign-in server and both
 * recovery servers held. One leaked copy of it was a recovery identity for every
 * account at once.
 */
@Injectable()
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly oidc: OidcService,
  ) {}

  private get settings() {
    return this.config.get('recovery', { infer: true });
  }

  /**
   * The rules this deployment runs, or a 404.
   *
   * A deployment that is not a recovery server answers as if the routes did not
   * exist: the main API host carries the same code, and a 503 there would invite
   * a client to retry somewhere it was never meant to register.
   */
  rules(): RecoveryRules {
    const s = this.settings;
    if (!s.role) throw notFound();
    return {
      role: s.role,
      sep10: {
        signingSecret: s.sep10SigningSecret,
        homeDomain: s.homeDomain,
        webAuthDomain: new URL(s.publicBaseUrl).host,
        networkPassphrase: s.networkPassphrase,
      },
      signerMaster: s.signerMaster,
      jwtSecret: s.jwtSecret,
      webAuthEndpoint: `${s.publicBaseUrl}/v1/sep10/auth`,
    };
  }

  /* --------------------------------- SEP-1 --------------------------------- */

  stellarToml(): string {
    const rules = this.rules();
    const s = this.settings;
    return buildStellarToml({
      rules,
      horizonUrl: s.horizonUrl,
      sep30Endpoint: `${s.publicBaseUrl}/v1/sep30`,
      oidcIssuer: s.oidc.issuer || null,
      emailCodes: Boolean(s.emailDelivery.url),
    });
  }

  /* --------------------------------- SEP-10 -------------------------------- */

  challenge(account: string) {
    const rules = this.rules();
    // G… only, checksummed: a muxed or mistyped account would be authenticated
    // under a string no registration can ever match.
    if (!account.startsWith('G') || !isAccountId(account)) {
      throw new SepError('Invalid account.', HttpStatus.BAD_REQUEST);
    }
    return {
      transaction: buildChallenge(rules.sep10, account),
      network_passphrase: rules.sep10.networkPassphrase,
    };
  }

  async token(transaction: string) {
    const rules = this.rules();
    // Structure first, Horizon second: a challenge that is not ours is refused
    // without a network call.
    const structure = readChallenge(rules.sep10, transaction);
    if (!structure.ok) {
      throw new SepError(
        `Invalid challenge (${structure.error}).`,
        HttpStatus.BAD_REQUEST,
      );
    }

    let signers;
    try {
      signers = await fetchAccountSigners(
        this.settings.horizonUrl,
        structure.account,
        this.settings.timeoutMs,
      );
    } catch (error) {
      this.logger.warn(`sep10: horizon lookup failed: ${String(error)}`);
      throw new SepError(
        'Could not read the account.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const verified = verifyChallenge(rules.sep10, transaction, signers);
    if (!verified.ok) {
      throw new SepError(
        `Invalid challenge (${verified.error}).`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    return { token: issueSep10Token(rules, verified.account) };
  }

  /* ------------------------------- identities ------------------------------ */

  /**
   * Exchange a provider's ID token for this server's identity token.
   *
   * The token is verified against the provider's keys, its login must be recent,
   * and this server accepts it once: the hash is recorded before anything is
   * issued, so two concurrent exchanges of one token cannot both succeed.
   */
  async exchangeIdToken(idToken: string) {
    const rules = this.rules();
    const { oidc, timeoutMs } = this.settings;
    if (!oidc.issuer) {
      throw new SepError(
        'This server does not accept ID tokens.',
        HttpStatus.NOT_FOUND,
      );
    }

    let result;
    try {
      result = await this.oidc.verify(
        idToken,
        {
          issuer: oidc.issuer,
          audiences: oidc.audiences,
          maxAgeSeconds: OIDC_MAX_LOGIN_AGE_S,
        },
        timeoutMs,
      );
    } catch (error) {
      this.logger.warn(
        `recovery identity: provider unreachable: ${String(error)}`,
      );
      throw new SepError(
        'The identity provider could not be reached.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!result.ok) {
      throw new SepError(
        `Invalid ID token (${result.error}).`,
        HttpStatus.UNAUTHORIZED,
      );
    }

    try {
      await this.prisma.recoveryUsedIdToken.create({
        data: {
          role: rules.role,
          tokenHash: sha256Hex(idToken),
          expiresAt: new Date(result.claims.exp * 1000),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new SepError(
          'This ID token was already exchanged here. Sign in again.',
          HttpStatus.UNAUTHORIZED,
        );
      }
      throw error;
    }

    return {
      token: issueIdentityToken(rules, result.claims.email),
      expires_in: IDENTITY_TOKEN_TTL_S,
    };
  }

  /**
   * Email a code that proves an inbox to THIS server.
   *
   * The answer is identical whether or not the address recovers anything here,
   * and delivery is not awaited — so neither the body nor the timing tells a
   * caller which inboxes are registered. A code is only actually sent to one that
   * is: this route must not be a way to make the service mail strangers.
   */
  async startEmail(rawEmail: string) {
    const rules = this.rules();
    const delivery = this.settings.emailDelivery;
    if (!delivery.url) {
      throw new SepError(
        'This server does not send recovery codes.',
        HttpStatus.NOT_FOUND,
      );
    }
    const email = normalizeEmail(rawEmail);

    const recent = await this.prisma.recoveryEmailCode.findFirst({
      where: {
        role: rules.role,
        email,
        status: RecoveryEmailCodeStatus.PENDING,
        sentAt: { gt: new Date(Date.now() - RECOVERY_CODE_RESEND_MS) },
      },
      select: { id: true },
    });
    if (recent) {
      throw new SepError(
        'A code was just sent. Wait a moment before asking for another.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // The total as well as the rate — see RECOVERY_CODE_DAILY_CAP. Counted on every
    // row, registered inbox or not, so the answer still says nothing about which.
    const today = await this.prisma.recoveryEmailCode.count({
      where: {
        role: rules.role,
        email,
        sentAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (today >= RECOVERY_CODE_DAILY_CAP) {
      throw new SepError(
        'Too many codes were sent to that address today. Try again tomorrow.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const claimToken = randomToken();
    const code = sixDigitCode();
    const expiresAt = new Date(Date.now() + RECOVERY_CODE_TTL_MS);
    await this.prisma.recoveryEmailCode.create({
      data: {
        role: rules.role,
        email,
        claimHash: sha256Hex(claimToken),
        codeHash: sha256Hex(code),
        expiresAt,
      },
    });

    const registered = await this.prisma.recoveryAuthMethod.count({
      where: { type: 'email', value: email, account: { role: rules.role } },
    });
    if (registered > 0) void this.deliver(email, code, expiresAt);

    return {
      claim_token: claimToken,
      expires_in: Math.floor(RECOVERY_CODE_TTL_MS / 1000),
    };
  }

  /** Answer a code. The attempt is counted before the comparison, on the row. */
  async verifyEmail(claimToken: string, code: string) {
    const rules = this.rules();
    const row = await this.prisma.recoveryEmailCode.findUnique({
      where: { claimHash: sha256Hex(claimToken) },
    });
    if (!row || row.role !== rules.role) return { status: 'expired' as const };
    if (row.status === RecoveryEmailCodeStatus.LOCKED)
      return { status: 'locked' as const };
    if (
      row.status !== RecoveryEmailCodeStatus.PENDING ||
      row.expiresAt.getTime() < Date.now()
    ) {
      return { status: 'expired' as const };
    }

    const attempts = row.attempts + 1;
    if (sha256Hex(code) !== row.codeHash) {
      const locked = attempts >= RECOVERY_CODE_MAX_ATTEMPTS;
      await this.prisma.recoveryEmailCode.updateMany({
        where: { id: row.id, status: RecoveryEmailCodeStatus.PENDING },
        data: {
          attempts,
          status: locked
            ? RecoveryEmailCodeStatus.LOCKED
            : RecoveryEmailCodeStatus.PENDING,
        },
      });
      return locked
        ? { status: 'locked' as const }
        : {
            status: 'invalid' as const,
            attempts_left: RECOVERY_CODE_MAX_ATTEMPTS - attempts,
          };
    }

    // Single-shot: two concurrent right answers cannot both get a token.
    const claimed = await this.prisma.recoveryEmailCode.updateMany({
      where: {
        id: row.id,
        status: RecoveryEmailCodeStatus.PENDING,
        attempts: row.attempts,
      },
      data: { attempts, status: RecoveryEmailCodeStatus.CLAIMED, codeHash: '' },
    });
    if (claimed.count !== 1) return { status: 'expired' as const };

    return {
      status: 'ready' as const,
      token: issueIdentityToken(rules, row.email),
      expires_in: IDENTITY_TOKEN_TTL_S,
    };
  }

  private async deliver(
    email: string,
    code: string,
    expiresAt: Date,
  ): Promise<void> {
    const { url, secret } = this.settings.emailDelivery;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cosmos-recovery-secret': secret,
        },
        body: JSON.stringify({
          email,
          code,
          expiresAt: expiresAt.toISOString(),
          role: this.settings.role,
        }),
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
      if (!res.ok)
        this.logger.error(`recovery code delivery answered ${res.status}`);
    } catch (error) {
      this.logger.error(`recovery code delivery failed: ${String(error)}`);
    }
  }

  /* --------------------------------- SEP-30 -------------------------------- */

  /** Who presented the bearer token, or a 401. */
  actor(authorization: string | undefined): Actor {
    const rules = this.rules();
    const token = /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? '')?.[1];
    const actor = token ? actorFromToken(rules, token) : null;
    if (!actor) throw unauthorized();
    return actor;
  }

  private response(
    rules: RecoveryRules,
    row: AccountRow,
    actor: Actor,
  ): AccountResponse {
    const roles = [...new Set(row.methods.map((m) => m.identityRole))].filter(
      (r): r is IdentityRole =>
        (IDENTITY_ROLES as readonly string[]).includes(r),
    );
    return {
      address: row.address,
      identities: roles.map((role) => ({
        role,
        // SEP-30 asks which identity the caller authenticated as.
        ...(authenticatesAs(actor, row.address, row.methods, role)
          ? { authenticated: true }
          : {}),
      })),
      signers: [
        {
          key: signerFor(rules.signerMaster, row.address).publicKey(),
          added_at: row.createdAt.toISOString(),
        },
      ],
    };
  }

  private find(
    rules: RecoveryRules,
    address: string,
  ): Promise<AccountRow | null> {
    return this.prisma.recoveryAccount.findUnique({
      where: { role_address: { role: rules.role, address } },
      include: { methods: true },
    });
  }

  private async write(
    rules: RecoveryRules,
    address: string,
    identities: Identity[],
  ): Promise<AccountRow> {
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.recoveryAccount.upsert({
        where: { role_address: { role: rules.role, address } },
        create: {
          role: rules.role,
          address,
          network: networkOf(rules.sep10.networkPassphrase),
        },
        update: { network: networkOf(rules.sep10.networkPassphrase) },
        select: { id: true },
      });
      // Replace, never merge: SEP-30's identities are "who may recover NOW", and a
      // merge would keep an inbox the owner meant to remove.
      await tx.recoveryAuthMethod.deleteMany({
        where: { accountId: account.id },
      });
      await tx.recoveryAuthMethod.createMany({
        data: identities.flatMap((identity) =>
          identity.auth_methods.map((m) => ({
            accountId: account.id,
            identityRole: identity.role,
            type: m.type,
            value: normalizeEmail(m.value),
          })),
        ),
      });
      return tx.recoveryAccount.findUniqueOrThrow({
        where: { id: account.id },
        include: { methods: true },
      });
    });
  }

  /**
   * POST — register. The key holder only: an identity that could add itself
   * would be a way in rather than a way back. 409 on an account already here,
   * never a silent overwrite: changing who may recover is PUT, which says so.
   */
  async register(
    authorization: string | undefined,
    address: string,
    identities: Identity[],
  ) {
    const rules = this.rules();
    const actor = this.actor(authorization);
    if (actor.kind !== 'address' || actor.address !== address)
      throw notTheKeyHolder();
    if (await this.find(rules, address)) {
      throw new SepError(
        'This account is already registered for recovery.',
        HttpStatus.CONFLICT,
      );
    }
    try {
      return this.response(
        rules,
        await this.write(rules, address, identities),
        actor,
      );
    } catch (error) {
      // Two registrations racing: the loser meets the unique index, not a merge.
      if (isUniqueViolation(error)) {
        throw new SepError(
          'This account is already registered for recovery.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  /** PUT — replace the identities. The key holder only, and an upsert per SEP-30. */
  async update(
    authorization: string | undefined,
    address: string,
    identities: Identity[],
  ) {
    const rules = this.rules();
    const actor = this.actor(authorization);
    if (actor.kind !== 'address' || actor.address !== address)
      throw notTheKeyHolder();
    return this.response(
      rules,
      await this.write(rules, address, identities),
      actor,
    );
  }

  /**
   * GET — describe. Absent and not-yours are the same 404 on purpose: a 403
   * would tell someone holding a stolen inbox that the account IS registered.
   */
  async get(authorization: string | undefined, address: string) {
    const rules = this.rules();
    const actor = this.actor(authorization);
    const row = await this.find(rules, address);
    if (!row || !mayAct(actor, address, row.methods)) throw notFound();
    return this.response(rules, row, actor);
  }

  /** DELETE — forget. Answers with the account it deleted, per SEP-30. */
  async remove(authorization: string | undefined, address: string) {
    const rules = this.rules();
    const actor = this.actor(authorization);
    if (actor.kind !== 'address' || actor.address !== address)
      throw notTheKeyHolder();
    const row = await this.find(rules, address);
    if (!row) throw notFound();
    const body = this.response(rules, row, actor);
    await this.prisma.recoveryAccount.delete({ where: { id: row.id } });
    return body;
  }

  /** GET /accounts — one page, keyset on the address. */
  async list(authorization: string | undefined, after?: string) {
    const rules = this.rules();
    const actor = this.actor(authorization);
    const rows = await this.prisma.recoveryAccount.findMany({
      where: listWhere(rules.role, actor, after),
      include: { methods: true },
      orderBy: { address: 'asc' },
      take: RECOVERY_PAGE_SIZE,
    });
    return { accounts: rows.map((row) => this.response(rules, row, actor)) };
  }

  /**
   * The co-signature. The only route that produces something with power, so what
   * it will sign is decided in one place, `signRefusal`, and the answer is the
   * SIGNATURE — never an envelope, which would invite the other server's half to
   * be quietly dropped.
   */
  async sign(
    authorization: string | undefined,
    address: string,
    signingAddress: string,
    xdr: string,
  ) {
    const rules = this.rules();
    const actor = this.actor(authorization);
    const row = await this.find(rules, address);
    if (!row || !mayAct(actor, address, row.methods)) throw notFound();

    const signer = signerFor(rules.signerMaster, address);
    // Asking for another account's signer must not work even for a caller who
    // may act for both.
    if (signer.publicKey() !== signingAddress) {
      throw new SepError(
        "That is not this server's signer for this account.",
        HttpStatus.NOT_FOUND,
      );
    }

    let tx: Transaction | FeeBumpTransaction;
    try {
      // This server's own passphrase: an envelope does not carry one, and a
      // caller-supplied one is how a signature ends up valid on another network.
      tx = TransactionBuilder.fromXDR(
        xdr.trim(),
        rules.sep10.networkPassphrase,
      );
    } catch {
      throw new SepError('That is not a transaction.', HttpStatus.BAD_REQUEST);
    }
    const refusal = signRefusal(tx, address);
    if (refusal) {
      // Named: a wallet that built the wrong transaction must see which rule it
      // broke, and the rules are public anyway.
      throw new SepError(
        `This server only signs account recovery (${refusal}).`,
        HttpStatus.FORBIDDEN,
      );
    }

    this.logger.log(`recovery: co-signed for ${address} as ${actor.kind}`);
    return {
      signature: Buffer.from(signer.sign((tx as Transaction).hash())).toString(
        'base64',
      ),
      network_passphrase: rules.sep10.networkPassphrase,
    };
  }
}
