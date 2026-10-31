import type { RateLimitPolicy } from '@/common/decorators/rate-limit.decorator';

/**
 * Tuning knobs for easy recovery: moving a wallet from an old device to a new
 * one through a short-lived mailbox. Behaviour lives in
 * `easy-recovery.service.ts`, the pure rules in `easy-recovery-core.ts`.
 *
 * The values a security review reads first are the three that bound a phishing
 * page: the lifetime, the attempt limit and the code's shape. A page that shows
 * its own QR holds the receiving key, so the sealed secret is readable to it;
 * what stands between it and the wallet is the code on the victim's screen, and
 * these numbers are how many tries, for how long, it gets at that code.
 */

// --- Lifetimes and limits ----------------------------------------------------

/**
 * How long a session lives, from the moment the new device opens it.
 *
 * Five minutes: two devices side by side, a scan, an unlock and five typed
 * digits. Long enough for a person who has to find the old phone first; short
 * enough that a QR photographed or left on a screen is worthless soon after. A
 * claimed session is kept until then as a tombstone, so the old device's poll
 * can read `claimed` instead of a 404 it cannot tell from a lost session.
 */
export const EASY_RECOVERY_TTL_MS = 300_000;

/**
 * Wrong codes a session survives. The fifth one deletes it.
 *
 * The code is five digits, so a guesser who gets five tries wins one time in
 * 20,000 — and has to start a new session (a new QR, a new scan and a new unlock
 * on the victim's device) to try again. This counter IS the protection against
 * a phishing page; the route budget only keeps a machine from reaching it fast.
 */
export const EASY_RECOVERY_MAX_ATTEMPTS = 5;

/**
 * The code the old device shows and the new device types: exactly five ASCII
 * digits. `[0-9]`, not `\d`, so the rule reads the same in any regex flavour.
 */
export const EASY_RECOVERY_CODE_PATTERN = /^[0-9]{5}$/;

/**
 * A session id: 16 random bytes, base64url without padding. Bytes, not
 * characters: the wire form is {@link EASY_RECOVERY_SESSION_ID_CHARS} long.
 */
export const EASY_RECOVERY_SESSION_ID_BYTES = 16;
export const EASY_RECOVERY_SESSION_ID_CHARS = 22;

/**
 * An X25519 public key is 32 bytes, which base64url without padding spells in
 * exactly 43 characters.
 */
export const EASY_RECOVERY_RECEIVER_KEY_BYTES = 32;
export const EASY_RECOVERY_RECEIVER_KEY_CHARS = 43;

/**
 * The longest sealed secret a session accepts, in base64url characters.
 *
 * A wallet's secret is a seed or a few keys: an ECIES envelope of one is a few
 * hundred characters. 8,192 leaves an order of magnitude for a format change
 * and keeps the shared key from parking megabytes in the table.
 */
export const EASY_RECOVERY_CIPHERTEXT_MAX_CHARS = 8192;

/** base64url without padding — every token on these routes is spelled in it. */
export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

// --- Rate limits -------------------------------------------------------------
//
// Per consumer + client address (per /64 on IPv6), fixed windows, so the true
// ceiling across a boundary is twice each number. Every anonymous wallet holds
// the SHARED public key and is the same consumer, so the client address is what
// tells them apart. None of these is per consumer alone: a global ceiling on a
// route the whole anonymous population shares would let one caller spend it
// for everyone.

const EASY_RECOVERY_WINDOW_MS = 10 * 60 * 1000;

/**
 * `POST /v1/wallet/easy-recovery/sessions`.
 *
 * Every call writes a row that lives five minutes. A person who closes and
 * reopens the screen a few times needs a handful; twenty keeps a loop from
 * filling the table.
 */
export const EASY_RECOVERY_CREATE_RATE_LIMIT: RateLimitPolicy = {
  name: 'easy-recovery-create',
  limit: 20,
  windowMs: EASY_RECOVERY_WINDOW_MS,
};

/**
 * `GET /v1/wallet/easy-recovery/sessions/{id}`.
 *
 * Deliberately loose: both devices poll it, often from behind the same home
 * router (one address), for up to the whole five minutes. Two devices polling
 * every two seconds spend 300 between them; this is there to stop a loop, not
 * to pace a wallet.
 */
export const EASY_RECOVERY_POLL_RATE_LIMIT: RateLimitPolicy = {
  name: 'easy-recovery-poll',
  limit: 600,
  windowMs: EASY_RECOVERY_WINDOW_MS,
};

/**
 * `POST /v1/wallet/easy-recovery/sessions/{id}/offer`. Once per session in any
 * honest use, and each one can park up to
 * {@link EASY_RECOVERY_CIPHERTEXT_MAX_CHARS} in the table.
 */
export const EASY_RECOVERY_OFFER_RATE_LIMIT: RateLimitPolicy = {
  name: 'easy-recovery-offer',
  limit: 20,
  windowMs: EASY_RECOVERY_WINDOW_MS,
};

/**
 * `POST /v1/wallet/easy-recovery/sessions/{id}/claim`.
 *
 * {@link EASY_RECOVERY_MAX_ATTEMPTS} on the row is the real bound on guessing
 * one session's code; this budget keeps a machine from walking many sessions,
 * and leaves a person who mistypes plenty of room.
 */
export const EASY_RECOVERY_CLAIM_RATE_LIMIT: RateLimitPolicy = {
  name: 'easy-recovery-claim',
  limit: 30,
  windowMs: EASY_RECOVERY_WINDOW_MS,
};

// --- Sweeper -----------------------------------------------------------------

/**
 * Rows one delete removes, and the most one sweep cycle examines.
 *
 * Batches rather than one `DELETE … WHERE expiresAt < now()`, so a backlog
 * drains over a few statements instead of one long one holding the advisory
 * lock. The cap keeps a cycle bounded even when a sibling replica keeps
 * deleting the page first.
 */
export const EASY_RECOVERY_SWEEP_BATCH_SIZE = 500;
export const EASY_RECOVERY_SWEEP_MAX_PER_CYCLE = 20_000;
