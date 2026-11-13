import { openJson, sealJson } from '@/common/sealed-box';
import type { StellarNetwork } from '@/config/configuration';
import {
  P2P_DIRECT_SESSION_MAX_CHARS,
  P2P_DIRECT_SESSION_MAX_MS,
  P2P_DIRECT_SESSION_PURPOSE,
} from '@/native-plugins/eldorado/eldorado.constants';

/**
 * The payer's session in the direct flow: their marketplace bearer token,
 * sealed for the page to hold and send back in `X-Payer-Session`.
 *
 * The token never leaves this service in clear and is never stored: the page
 * holds `sealJson({ t, n, r, e })` (AES-256-GCM under a key derived from
 * `P2P_DIRECT_SESSION_SECRET` for this purpose alone, URL-safe), and every
 * route opens it again. A session opens only for the payment request (`r`) and
 * the network (`n`) it was issued for, and only before `e`: the marketplace's
 * own expiry, capped at {@link P2P_DIRECT_SESSION_MAX_MS}. An altered,
 * truncated, foreign or stale one opens as nothing, and the routes answer it
 * `401 session_expired` without saying which it was. Pure, so a spec calls it
 * with a secret of its own.
 */

/** What a session seals. Short keys: the box travels in a header. */
export interface PayerSessionClaims {
  /** The marketplace's bearer token for the payer. */
  t: string;
  /** The network the request (and so the marketplace environment) is on. */
  n: StellarNetwork;
  /** The payment request it was issued for. */
  r: string;
  /** When it stops opening, in ms since the epoch. */
  e: number;
}

/** When a session issued at `now` for a token the marketplace says expires at `tokenExpiresAt` stops opening. */
export function sessionExpiry(now: number, tokenExpiresAt: number | null) {
  const cap = now + P2P_DIRECT_SESSION_MAX_MS;
  return tokenExpiresAt === null ? cap : Math.min(tokenExpiresAt, cap);
}

/** Seals a session for the page. */
export function sealPayerSession(
  claims: PayerSessionClaims,
  secret: string,
): string {
  return sealJson(claims, secret, P2P_DIRECT_SESSION_PURPOSE);
}

/**
 * The claims of `sealed` when it opens under `secret` and was issued for
 * `expected` (the request and its network) and is not past its expiry at
 * `now`; null for anything else.
 */
export function openPayerSession(
  sealed: string | undefined,
  secret: string,
  expected: { requestId: string; network: StellarNetwork },
  now: number,
): PayerSessionClaims | null {
  if (
    !secret ||
    typeof sealed !== 'string' ||
    !sealed ||
    sealed.length > P2P_DIRECT_SESSION_MAX_CHARS
  ) {
    return null;
  }
  const claims = openJson<Partial<PayerSessionClaims>>(
    sealed.trim(),
    secret,
    P2P_DIRECT_SESSION_PURPOSE,
  );
  if (
    !claims ||
    typeof claims.t !== 'string' ||
    !claims.t ||
    typeof claims.e !== 'number' ||
    !Number.isFinite(claims.e)
  ) {
    return null;
  }
  if (claims.r !== expected.requestId || claims.n !== expected.network) {
    return null;
  }
  if (claims.e <= now) return null;
  return claims as PayerSessionClaims;
}
