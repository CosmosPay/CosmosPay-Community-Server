import { hkdfSync } from 'node:crypto';
import {
  FeeBumpTransaction,
  Keypair,
  Networks,
  Transaction,
} from '@stellar/stellar-sdk';
import { issueJwt, readJwt } from '@/common/jwt';
import {
  IDENTITY_TOKEN_TTL_S,
  RECOVERY_CLOCK_SKEW_S,
  RECOVERY_SIGN_MAX_FEE_STROOPS,
  RECOVERY_SIGN_MAX_OPS,
  RECOVERY_SIGN_MAX_WINDOW_S,
  SEP10_TOKEN_TTL_S,
} from '@/recovery/recovery.constants';
import type { Sep10Config } from '@/recovery/sep10-core';

/**
 * SEP-30 account recovery, from the server's side — the rules, with no Prisma,
 * no network and no config reads, so the spec beside it reaches every one.
 *
 * ## What one of these servers is
 *
 * One of TWO. The wallet registers an account with both and puts on chain the
 * key each derives for it, at half the account's threshold. Neither alone can
 * sign anything; both together can put a new key in place of a lost one. Both
 * run this same code, so what keeps them apart is entirely configuration — a
 * different role, signing key, JWT secret and host — and ideally a different
 * database and operator. Replicas of ONE role behind a load balancer are fine and
 * expected: nothing here is per-process state.
 *
 * ## What this server will put its name to
 *
 * A recovery transaction and nothing else (`signRefusal`). SEP-30 leaves the
 * policy to the server, and the generous reading — sign whatever an
 * authenticated identity asks for — makes each server a payment service for
 * anyone who can receive the person's email.
 *
 * ## Who may ask
 *
 * Two credentials, both JWTs minted here under this server's own secret and
 * audience: one whose subject is the ACCOUNT (a SEP-10 token: "I still hold the
 * key") and one whose subject is an IDENTITY ("I proved this inbox"). The first
 * registers and changes identities; the second can only read and ask for a
 * signature. Neither is ever accepted by the sibling server.
 */

/* --------------------------------- types ---------------------------------- */

/** SEP-30 identity roles. The wallet only ever registers `owner`. */
export const IDENTITY_ROLES = ['owner', 'sender', 'receiver'] as const;
export type IdentityRole = (typeof IDENTITY_ROLES)[number];

/**
 * The auth methods this server accepts at registration.
 *
 * `email` only. SEP-30 also names `phone_number` and `stellar_address`, and each
 * one is another way into the same account that an attacker needs only one of.
 * This server has no way to PROVE a phone number, and a `stellar_address` method
 * would make a second key a recovery credential — which is a co-signer, and
 * belongs on the ledger where the owner can see it.
 */
export const AUTH_METHOD_TYPES = ['email'] as const;
export type AuthMethodType = (typeof AUTH_METHOD_TYPES)[number];

export interface AuthMethod {
  type: AuthMethodType;
  value: string;
}

export interface Identity {
  role: IdentityRole;
  auth_methods: AuthMethod[];
}

/** Who is asking: the account itself (SEP-10), or an identity proven to this server. */
export type Actor =
  | { kind: 'address'; address: string }
  | { kind: 'identity'; type: AuthMethodType; value: string };

/** What every account route answers with, in SEP-30's shape. */
export interface AccountResponse {
  address: string;
  identities: { role: IdentityRole; authenticated?: boolean }[];
  signers: { key: string; added_at: string }[];
}

/** The subset of configuration the rules below read. */
export interface RecoveryRules {
  role: 'a' | 'b';
  sep10: Sep10Config;
  signerMaster: string;
  jwtSecret: string;
  /** The URL SEP-10 tokens name as their issuer — the published WEB_AUTH_ENDPOINT. */
  webAuthEndpoint: string;
}

/** An email is compared lowercased and trimmed. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/* ------------------------------- the signer -------------------------------- */

/**
 * This server's signer FOR ONE ACCOUNT.
 *
 * Deterministic and one-way: the address is public, the master seed is not, and
 * no derived key leads back to it or sideways to another account's. There is no
 * table of keys to leak, and the same address always derives the same signer —
 * which matters because that key is a signer ON CHAIN. Lose the master seed and
 * every account registered here keeps a signer nobody can produce a signature
 * for; back it up like the money it guards, and never rotate it while an account
 * still names it.
 *
 * The derivation is byte-for-byte the developer platform's, which served this
 * before: an operator moving a role here keeps its master seed, and every account
 * registered there keeps a working signer.
 */
export function signerFor(signerMaster: string, address: string): Keypair {
  const seed = hkdfSync(
    'sha256',
    Keypair.fromSecret(signerMaster).rawSecretKey(),
    'cosmos-recovery-signer',
    address,
    32,
  );
  return Keypair.fromRawEd25519Seed(Buffer.from(seed));
}

/* ------------------------------- the tokens -------------------------------- */

const sep10Purpose = (role: string) => `sep10:${role}`;
const identityPurpose = (role: string) => `recovery-identity:${role}`;

/** The SEP-10 token a verified challenge buys. */
export function issueSep10Token(
  rules: RecoveryRules,
  account: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  return issueJwt(
    {
      sub: account,
      // SEP-10: `iss` is the URI of the web-auth endpoint that issued the token.
      iss: rules.webAuthEndpoint,
      aud: rules.sep10.webAuthDomain,
      iat: nowSeconds,
      exp: nowSeconds + SEP10_TOKEN_TTL_S,
      home_domain: rules.sep10.homeDomain,
    },
    rules.jwtSecret,
    sep10Purpose(rules.role),
  );
}

/** The identity token an ID-token exchange or an emailed code buys. */
export function issueIdentityToken(
  rules: RecoveryRules,
  email: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  return issueJwt(
    {
      sub: `email:${normalizeEmail(email)}`,
      iss: rules.webAuthEndpoint,
      aud: rules.sep10.webAuthDomain,
      iat: nowSeconds,
      exp: nowSeconds + IDENTITY_TOKEN_TTL_S,
    },
    rules.jwtSecret,
    identityPurpose(rules.role),
  );
}

/**
 * Who presented `token`, or null.
 *
 * Tried as a SEP-10 token first and an identity token second, each under its OWN
 * derived key — so an identity token can never be read as "holds the key", which
 * is the confusion that would let an inbox register itself on an account.
 */
export function actorFromToken(
  rules: RecoveryRules,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Actor | null {
  const audience = rules.sep10.webAuthDomain;
  const sep10 = readJwt(
    token,
    rules.jwtSecret,
    sep10Purpose(rules.role),
    audience,
    nowSeconds,
  );
  if (sep10) return { kind: 'address', address: sep10.sub };

  const identity = readJwt(
    token,
    rules.jwtSecret,
    identityPurpose(rules.role),
    audience,
    nowSeconds,
  );
  if (!identity) return null;
  const at = identity.sub.indexOf(':');
  const type = identity.sub.slice(0, at);
  const value = identity.sub.slice(at + 1);
  if (type !== 'email' || !value) return null;
  return { kind: 'identity', type: 'email', value };
}

/* ------------------------------- the listing ------------------------------- */

/**
 * Which accounts a caller may see, and where their page starts — the `where`
 * for SEP-30's `GET /accounts`.
 *
 * `after` arrives from the URL, so it is the caller's, and it is combined with an
 * AND rather than merged over the scope: a merge lets a key in the cursor
 * overwrite the same key in the scope, which is how a pagination parameter turns
 * into a way to read another identity's accounts. Keyset on the address, because
 * an OFFSET over a table being written to skips rows.
 */
export function listWhere(
  role: string,
  actor: Actor,
  after?: string,
): Record<string, unknown> {
  const scope =
    actor.kind === 'address'
      ? { role, address: actor.address }
      : { role, methods: { some: { type: actor.type, value: actor.value } } };
  return after ? { AND: [scope, { address: { gt: after } }] } : scope;
}

/** Does `actor` authenticate as the identity in `role` on this account? */
export function authenticatesAs(
  actor: Actor,
  address: string,
  methods: readonly { identityRole: string; type: string; value: string }[],
  role: IdentityRole,
): boolean {
  if (actor.kind === 'address') return actor.address === address;
  return methods.some(
    (m) =>
      m.identityRole === role &&
      m.type === actor.type &&
      m.value === actor.value,
  );
}

/** May this caller read the account, or ask for a signature on it? */
export function mayAct(
  actor: Actor,
  address: string,
  methods: readonly { type: string; value: string }[],
): boolean {
  if (actor.kind === 'address') return actor.address === address;
  return methods.some((m) => m.type === actor.type && m.value === actor.value);
}

/* ------------------------------- the policy -------------------------------- */

export type SignRefusal =
  | 'fee_bump'
  | 'foreign_source'
  | 'no_operations'
  | 'too_many_operations'
  | 'fee_too_high'
  | 'no_expiry'
  | 'window_too_long'
  | 'not_yet_valid'
  | 'memo_not_allowed'
  | 'operation_not_allowed'
  | 'foreign_operation_source'
  | 'unsupported_signer'
  | 'option_not_allowed';

/**
 * Why this server will not co-sign, or null when it will.
 *
 * It is the whole of what a compromised inbox can ask this server to do, so it is
 * the one piece that has to be right. The transaction must be an account-control
 * change on the registered account and nothing else:
 *
 *  - sourced by the account, bounded in fee, operation count and TIME — a window
 *    no longer than `RECOVERY_SIGN_MAX_WINDOW_S`, because a co-signature with no
 *    near expiry is a standing instrument to take the account over later;
 *  - `setOptions` that touches ONLY signers, the master weight and thresholds.
 *    Flags, home domain and inflation destination are refused: nothing a device
 *    replacement needs, and `setFlags` on an issuing account is how an asset's
 *    authorization rules change;
 *  - the sponsorship pair, so an account that cannot pay a new signer's reserve
 *    can still be recovered — as long as the reserve being paid for is THIS
 *    account's.
 *
 * It does not make a stolen inbox harmless: whoever holds it can still have a key
 * of their choosing put on the account. It means they have to do it on chain, in
 * one visible transaction, rather than quietly asking for a payment.
 */
export function signRefusal(
  tx: Transaction | FeeBumpTransaction,
  address: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): SignRefusal | null {
  if (tx instanceof FeeBumpTransaction) return 'fee_bump';
  if (tx.source !== address) return 'foreign_source';
  if (!tx.operations.length) return 'no_operations';
  if (tx.operations.length > RECOVERY_SIGN_MAX_OPS)
    return 'too_many_operations';
  const fee = Number(tx.fee);
  if (!Number.isFinite(fee) || fee < 0 || fee > RECOVERY_SIGN_MAX_FEE_STROOPS)
    return 'fee_too_high';

  const max = tx.timeBounds ? Number(tx.timeBounds.maxTime) : 0;
  const min = tx.timeBounds ? Number(tx.timeBounds.minTime) : 0;
  if (!Number.isFinite(max) || max <= 0) return 'no_expiry';
  if (max > nowSeconds + RECOVERY_SIGN_MAX_WINDOW_S + RECOVERY_CLOCK_SKEW_S)
    return 'window_too_long';
  if (!Number.isFinite(min) || min > nowSeconds + RECOVERY_CLOCK_SKEW_S)
    return 'not_yet_valid';
  // A memo is a message to a third party; a key replacement has no third party.
  if (tx.memo.type !== 'none') return 'memo_not_allowed';

  for (const op of tx.operations) {
    switch (op.type) {
      case 'setOptions': {
        if (op.source && op.source !== address)
          return 'foreign_operation_source';
        // Only ordinary key signers. A hash, pre-authorized or signed-payload
        // signer is a different instrument, and never what a new device needs.
        if (op.signer && !('ed25519PublicKey' in op.signer))
          return 'unsupported_signer';
        if (
          op.setFlags !== undefined ||
          op.clearFlags !== undefined ||
          op.homeDomain !== undefined ||
          op.inflationDest !== undefined
        ) {
          return 'option_not_allowed';
        }
        break;
      }
      case 'beginSponsoringFutureReserves':
        // The sponsor is somebody else's account by definition; what matters is
        // that the reserve being paid for is THIS account's.
        if (op.sponsoredId !== address) return 'foreign_operation_source';
        break;
      case 'endSponsoringFutureReserves':
        if (op.source && op.source !== address)
          return 'foreign_operation_source';
        break;
      default:
        return 'operation_not_allowed';
    }
  }
  return null;
}

/* ---------------------------------- TOML ----------------------------------- */

/** TOML basic string: the spec's escapes, and no newline survives into a value. */
const q = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;

export interface TomlInput {
  rules: RecoveryRules;
  horizonUrl: string;
  /** The SEP-30 base: `${sep30Endpoint}/accounts` is `GET /accounts`. */
  sep30Endpoint: string;
  /** The OIDC issuer whose ID tokens this server exchanges, when it takes any. */
  oidcIssuer: string | null;
  /** Whether this server can prove an inbox by itself, with an emailed code. */
  emailCodes: boolean;
}

/**
 * `/.well-known/stellar.toml` — how a client that is not our wallet finds this
 * server, and how ours checks it.
 *
 * SEP-30 defines no discovery; SEP-10 does, through two SEP-1 fields:
 * `WEB_AUTH_ENDPOINT`, and `SIGNING_KEY` — the one that turns SEP-10 from a
 * ritual into a proof, since without it a client cannot tell a challenge from
 * this server apart from one minted by whoever answered the request. It is
 * DERIVED from the secret here, never configured beside it: two fields that must
 * agree are two fields that can disagree.
 *
 * `HOME_DOMAIN` is the WALLET's domain, not this host: the two recovery servers
 * are different hosts that deliberately name the same one, and a client checks
 * that they agree — whoever controls one server cannot change what the other
 * says.
 *
 * The `[[RECOVERY_SERVERS]]` table is not a SEP-1 field; it is how the SEP-30
 * base, the role and the identity methods are published, which SEP-30 leaves to
 * the operator.
 */
export function buildStellarToml(input: TomlInput): string {
  const { rules } = input;
  const signingKey = Keypair.fromSecret(rules.sep10.signingSecret).publicKey();
  const lines = [
    '# Cosmos Pay - SEP-30 recovery server.',
    `VERSION = ${q('2.7.0')}`,
    `NETWORK_PASSPHRASE = ${q(rules.sep10.networkPassphrase)}`,
    `HORIZON_URL = ${q(input.horizonUrl)}`,
    `WEB_AUTH_ENDPOINT = ${q(rules.webAuthEndpoint)}`,
    `SIGNING_KEY = ${q(signingKey)}`,
    `HOME_DOMAIN = ${q(rules.sep10.homeDomain)}`,
    '',
    '[[RECOVERY_SERVERS]]',
    `ENDPOINT = ${q(input.sep30Endpoint)}`,
    `ROLE = ${q(rules.role)}`,
  ];
  if (input.oidcIssuer) lines.push(`OIDC_ISSUER = ${q(input.oidcIssuer)}`);
  lines.push(`EMAIL_CODES = ${input.emailCodes ? 'true' : 'false'}`, '');
  return lines.join('\n');
}

/** The network a passphrase names, for the row a registration writes. */
export function networkOf(passphrase: string): 'public' | 'testnet' | 'other' {
  if (passphrase === String(Networks.PUBLIC)) return 'public';
  if (passphrase === String(Networks.TESTNET)) return 'testnet';
  return 'other';
}
