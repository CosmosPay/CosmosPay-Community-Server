import type { RateLimitPolicy } from '@/common/decorators/rate-limit.decorator';

/**
 * Tuning knobs for SEP-10 and SEP-30. Behaviour lives in `recovery.service.ts`;
 * the rules that decide things live in `recovery-core.ts` and `sep10-core.ts`.
 */

// --- SEP-10 ----------------------------------------------------------------

/** How long a challenge stays signable. SEP-10's own recommendation. */
export const SEP10_CHALLENGE_TTL_S = 15 * 60;

/** SEP-10 requires 48 random bytes, base64 — exactly 64 characters. */
export const SEP10_NONCE_BYTES = 48;

/**
 * What a SEP-10 token is good for.
 *
 * One hour, not the day SEP-10 allows. The wallet authenticates immediately
 * before each registration, update or removal, and a token that outlives that by
 * twenty-three hours is a credential nobody is using except whoever copied it.
 */
export const SEP10_TOKEN_TTL_S = 60 * 60;

// --- identities --------------------------------------------------------------

/**
 * What an identity token — "this caller proved this inbox" — is good for.
 *
 * As long as a recovery takes to walk through, and no longer. It is the
 * credential of someone who has lost their key, which is exactly the credential
 * a thief would want, so it is short and it is scoped to one server.
 */
export const IDENTITY_TOKEN_TTL_S = 30 * 60;

/**
 * The oldest login an ID token may stand for when it is exchanged here.
 *
 * Fifteen minutes. A provider's token can outlive the moment its person was in
 * front of the screen; recovery is the one flow where that moment is the whole
 * of what is being proven.
 */
export const OIDC_MAX_LOGIN_AGE_S = 15 * 60;

/** How long an emailed recovery code lives. */
export const RECOVERY_CODE_TTL_MS = 15 * 60 * 1000;

/** Wrong codes before a recovery code is burned. */
export const RECOVERY_CODE_MAX_ATTEMPTS = 5;

/** One recovery code per mailbox per minute, enforced on the row. */
export const RECOVERY_CODE_RESEND_MS = 60 * 1000;

/**
 * Recovery codes one mailbox may be sent in a day, by this server.
 *
 * The same arithmetic as the sign-in's `LOGIN_CODE_DAILY_CAP`: a per-minute
 * cooldown alone lets someone collect thousands of blind guesses a day against
 * one inbox, and on this route a right guess is half of taking the account.
 */
export const RECOVERY_CODE_DAILY_CAP = 10;

// --- SEP-30 ----------------------------------------------------------------

/** How many accounts one page of `GET /accounts` carries. */
export const RECOVERY_PAGE_SIZE = 100;

/** Stroops. A recovery transaction is a handful of operations; this only stops a drain. */
export const RECOVERY_SIGN_MAX_FEE_STROOPS = 10_000_000;

/** Operations a transaction this server co-signs may carry. */
export const RECOVERY_SIGN_MAX_OPS = 8;

/**
 * The furthest in the future a co-signed transaction may stay valid.
 *
 * The signature is handed to whoever asked for it, and a signature with a long
 * window is a standing instrument: it can be submitted later, by anyone who has
 * it, after the person who asked has changed their mind. Fifteen minutes is time
 * to collect the other server's half and submit.
 */
export const RECOVERY_SIGN_MAX_WINDOW_S = 15 * 60;

/** Tolerated clock difference on the window above. */
export const RECOVERY_CLOCK_SKEW_S = 5 * 60;

// --- sweeper ---------------------------------------------------------------

export const RECOVERY_SWEEP_BATCH_SIZE = 500;

/** Spent rows are kept a day, so "already used" and "never existed" stay distinct. */
export const RECOVERY_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

// --- rate limits -------------------------------------------------------------
//
// Every route here is public: SEP-10 and SEP-30 are standards someone else's
// client calls with no API key, and the SEP-10 token or the identity token is
// the credential. So the subject of every budget is the client address alone,
// and these are the real ceilings.

const WINDOW_MS = 10 * 60 * 1000;

export const SEP10_CHALLENGE_RATE_LIMIT: RateLimitPolicy = {
  name: 'sep10-challenge',
  limit: 60,
  windowMs: WINDOW_MS,
};

/** Verifying a challenge may cost a Horizon round trip. */
export const SEP10_TOKEN_RATE_LIMIT: RateLimitPolicy = {
  name: 'sep10-token',
  limit: 60,
  windowMs: WINDOW_MS,
};

export const SEP30_READ_RATE_LIMIT: RateLimitPolicy = {
  name: 'sep30-read',
  limit: 120,
  windowMs: WINDOW_MS,
};

export const SEP30_WRITE_RATE_LIMIT: RateLimitPolicy = {
  name: 'sep30-write',
  limit: 30,
  windowMs: WINDOW_MS,
};

/** The one route that produces something with power. */
export const SEP30_SIGN_RATE_LIMIT: RateLimitPolicy = {
  name: 'sep30-sign',
  limit: 20,
  windowMs: WINDOW_MS,
};

/** An ID token exchange may cost a JWKS fetch. */
export const RECOVERY_IDENTITY_RATE_LIMIT: RateLimitPolicy = {
  name: 'recovery-identity',
  limit: 30,
  windowMs: WINDOW_MS,
};

/** The route that sends mail to an address the caller chose. */
export const RECOVERY_EMAIL_RATE_LIMIT: RateLimitPolicy = {
  name: 'recovery-email',
  limit: 5,
  windowMs: WINDOW_MS,
};

export const RECOVERY_CODE_RATE_LIMIT: RateLimitPolicy = {
  name: 'recovery-code',
  limit: 30,
  windowMs: WINDOW_MS,
};
