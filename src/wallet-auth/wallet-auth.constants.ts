import type { RateLimitPolicy } from '@/common/decorators/rate-limit.decorator';

/**
 * Tuning knobs for the wallet's own sign-in. Behaviour lives in
 * `wallet-auth.service.ts`, the rules that decide things in `wallet-auth-core.ts`.
 *
 * Every lifetime here was carried over from the developer platform's
 * `src/lib/wallet-auth-core.ts` along with the reasoning for it. A value changed
 * on one side and not the other is a sign-in that starts on one and cannot finish
 * on the other, for as long as both are serving.
 */

// --- Lifetimes -------------------------------------------------------------

/** A handshake is a person reading a consent screen: minutes, not hours. */
export const HANDSHAKE_TTL_MS = 10 * 60 * 1000;

/**
 * How long an emailed code lives.
 *
 * Fifteen minutes. The flow starts in the wallet and finishes in a mail client,
 * possibly on another device, and a code that expires while someone is still
 * finding the email produces a retry — which is a second email, and email is the
 * leg that reaches a stranger's inbox.
 */
export const LOGIN_CODE_TTL_MS = 15 * 60 * 1000;

/**
 * How many wrong codes burn a login code.
 *
 * Six digits is a million, so five attempts is not a meaningful bound on
 * guessing — it bounds how long one intercepted code stays useful, and it stops
 * an unbounded loop against a live row. A burned code is replaced by asking for
 * another, which is rate-limited in turn.
 */
export const LOGIN_CODE_MAX_ATTEMPTS = 5;

/**
 * One code per mailbox per minute.
 *
 * The cooldown is enforced on the row, not only by the route budget: the route
 * is keyed by consumer plus client address, and the thing being protected is
 * somebody else's inbox. Rotating an address must not buy another email.
 */
export const LOGIN_CODE_RESEND_MS = 60 * 1000;

/**
 * What a finished sign-in buys.
 *
 * Long enough to type a password and let PBKDF2 run on a slow phone, short
 * enough that a leaked token is stale before anyone finds it. It is the only
 * credential that can create an account or put a backup under one, and it is
 * never refreshed — a person who takes longer signs in again.
 */
export const SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * How far a signed timestamp may sit from this server's clock.
 *
 * Ten minutes each way. A phone's clock is not NTP-disciplined, and a device
 * running a few minutes fast would otherwise have every signature it ever made
 * refused — with an error that blames the server.
 */
export const SIGNED_AT_SKEW_MS = 10 * 60 * 1000;

/**
 * How long a terminal handshake or login code row is kept before the sweeper
 * removes it.
 *
 * A row that is simply gone is indistinguishable from one that never existed,
 * and the two need different answers: "you already redeemed this" and "no such
 * handshake" are different sentences for the person staring at the screen.
 */
export const WALLET_AUTH_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

// --- The backup box --------------------------------------------------------

/** Larger than any box the wallet writes by an order of magnitude; smaller than abuse. */
export const BACKUP_BOX_MAX_CHARS = 8192;

/**
 * The floor on the box's own PBKDF2 cost, and the ceiling on it.
 *
 * This service cannot open a box, but it does decide what it keeps, and a box is
 * only as strong as the derivation that sealed it: whoever reads this table gets
 * unlimited offline guesses at every row in it. A client that regressed to a
 * cheap cost would be uploading something close to plaintext with nothing on the
 * record to say so. The wallet seals well above the floor.
 *
 * The ceiling is not a security bound — it stops a caller storing a number that
 * makes its own box take an hour to open on the device that has to open it.
 */
export const BACKUP_MIN_ITERATIONS = 600_000;
export const BACKUP_MAX_ITERATIONS = 4_000_000;

// --- Rate limits -----------------------------------------------------------
//
// Budgets are per consumer + client address (per /64 on IPv6). The window is
// fixed, so the true ceiling across a boundary is twice these numbers.
//
// Note what the subject means on these routes. The wallet reaches them with the
// SHARED public key, so every anonymous wallet on the platform is one consumer
// and the client address is the only thing telling them apart. That makes the
// per-address budgets the real ones here, and it is why the email route carries
// a cooldown on the row as well.

const WALLET_AUTH_WINDOW_MS = 10 * 60 * 1000;

/**
 * `POST /v1/wallet/auth/oauth/authorize`.
 *
 * Every call writes a handshake row that outlives its TTL by the sweep grace, so
 * a loop grows the table a day at a time. A person who fumbles a consent screen
 * retries a handful of times; twenty leaves room for that.
 */
export const WALLET_AUTH_AUTHORIZE_RATE_LIMIT: RateLimitPolicy = {
  name: 'wallet-auth-authorize',
  limit: 20,
  windowMs: WALLET_AUTH_WINDOW_MS,
};

/**
 * `GET /v1/wallet/auth/oauth/session/:state`.
 *
 * Deliberately loose: a wallet polls this every couple of seconds for as long as
 * someone reads a consent screen, which is the normal, correct use of the route.
 * It exists to stop a loop, not to pace a client.
 */
export const WALLET_AUTH_POLL_RATE_LIMIT: RateLimitPolicy = {
  name: 'wallet-auth-poll',
  limit: 600,
  windowMs: WALLET_AUTH_WINDOW_MS,
};

/**
 * `POST /v1/wallet/auth/email/start` — the tight one.
 *
 * This is the only route here that makes the service send mail to an address the
 * caller chose. Five in ten minutes per address, on top of the per-row cooldown
 * that protects a single mailbox from an address rotation.
 */
export const WALLET_AUTH_EMAIL_RATE_LIMIT: RateLimitPolicy = {
  name: 'wallet-auth-email',
  limit: 5,
  windowMs: WALLET_AUTH_WINDOW_MS,
};

/**
 * `POST /v1/wallet/auth/email/verify` and `/oauth/claim`.
 *
 * A redemption is one call per finished sign-in. The budget is what stops a
 * caller walking the code space of somebody else's live login code faster than
 * `LOGIN_CODE_MAX_ATTEMPTS` can burn it — the attempt counter is the real bound,
 * this one keeps the attempt counter from being reached by a machine.
 */
export const WALLET_AUTH_CLAIM_RATE_LIMIT: RateLimitPolicy = {
  name: 'wallet-auth-claim',
  limit: 30,
  windowMs: WALLET_AUTH_WINDOW_MS,
};

/**
 * `POST /v1/wallet/auth/finish` and `PUT /v1/wallet/backup`.
 *
 * Both verify an ed25519 signature before they write, which costs real CPU on a
 * route reachable with the shared key. Both are also once-per-flow in any honest
 * use.
 */
export const WALLET_AUTH_FINISH_RATE_LIMIT: RateLimitPolicy = {
  name: 'wallet-auth-finish',
  limit: 20,
  windowMs: WALLET_AUTH_WINDOW_MS,
};

// --- Sweeper ---------------------------------------------------------------

/**
 * How many stale rows one sweep pass retires, per table.
 *
 * A bound rather than a target: the sweeper runs every minute, so a backlog
 * drains over a few passes instead of arriving as one long transaction holding
 * an advisory lock while the rest of the service waits behind it.
 */
export const WALLET_AUTH_SWEEP_BATCH_SIZE = 500;
