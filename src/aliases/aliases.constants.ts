/** Tuning knobs for claimable aliases. Behaviour lives in `aliases.service.ts`. */

/**
 * How long a signature challenge stays spendable.
 *
 * Five minutes: long enough for a person to read a confirmation, unlock a wallet
 * and approve, short enough that a nonce lifted from a log or a screen recording
 * is worthless by the time anyone acts on it. Challenges are single-use as well —
 * the window is the second bound, not the only one.
 */
export const ALIAS_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * How long an emailed recovery token lives.
 *
 * Thirty minutes rather than the challenge's five. Recovery starts in one place
 * (the app) and finishes in another (a mail client, possibly on another device),
 * and a token that expires while someone is still finding the email produces a
 * retry — which is a second email, and email is the rate-limited leg.
 */
export const ALIAS_RECOVERY_TTL_MS = 30 * 60 * 1000;

/**
 * How many times a live recovery token may be presented before the recovery is
 * burned.
 *
 * An attempt counts only against the recovery the token names: its hash has to
 * match an unspent, unexpired recovery of this alias. The count is taken before
 * the challenge and signature are checked, so a real token with a bad proof uses
 * one attempt, and a token that matches nothing writes nothing at all. It used to
 * work the other way: every bad token counted against the alias's live recovery.
 * Alias names are public, so any key could send five junk tokens and burn the
 * recovery the console had just started for the owner, as often as the owner
 * started one.
 *
 * This is not a bound on guessing, since tokens are 256 bits. It bounds how many
 * proofs one leaked token can be tried with. The ladder check and the increment
 * are a single statement, so concurrent requests cannot overshoot it. Burning the
 * recovery instead of locking the alias is deliberate: the owner starts another
 * one with a fresh email, and nobody can lock a name by failing at it.
 */
export const ALIAS_RECOVERY_MAX_ATTEMPTS = 5;

// --- Rate limits -----------------------------------------------------------
//
// Budgets are per consumer + client address (per /64 on IPv6). The window is
// fixed, so the true ceiling across a window boundary is twice these numbers. The
// span matches the Pollar and webhook budgets.

const ALIAS_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/**
 * `POST /v1/aliases/challenges`.
 *
 * Every call writes an `alias_challenge` row, and the row outlives its five-minute
 * TTL by `ALIAS_SWEEP_GRACE_MS`, so an unbounded loop grows the table a day at a
 * time. A real flow needs one challenge per signature (a claim, an added address,
 * a recovery), and someone who fumbles a wallet approval asks again a few times.
 * Thirty leaves room for that and caps a loop at 180 rows an hour per address.
 */
export const ALIAS_CHALLENGE_RATE_LIMIT = {
  name: 'aliases:challenge',
  limit: 30,
  windowMs: ALIAS_RATE_LIMIT_WINDOW_MS,
};

/**
 * `POST /v1/aliases/:name/recovery/complete`.
 *
 * A completed recovery hands a name, and every payment sent to it, to the caller.
 * Names are public, so anyone with `payments:write` can point this route at any
 * alias. Junk tokens no longer write anything (see
 * {@link ALIAS_RECOVERY_MAX_ATTEMPTS}), which leaves this limit as the only bound
 * on how fast one address can try. Ten is twice the attempt ladder: an owner
 * whose first recovery burned out can start another and still finish it within
 * the same window.
 */
export const ALIAS_RECOVERY_COMPLETE_RATE_LIMIT = {
  name: 'aliases:recovery-complete',
  limit: 10,
  windowMs: ALIAS_RATE_LIMIT_WINDOW_MS,
};

/**
 * Addresses one alias may point at.
 *
 * A real person has a handful — a phone, a desktop, a cold wallet, testnet. The
 * cap exists because resolution returns the whole list to a payer's wallet, and an
 * unbounded list is an unbounded response on the one endpoint that must stay fast
 * and is reachable with the shared public key.
 */
export const ALIAS_MAX_ADDRESSES = 20;

/**
 * Aliases one consumer may hold.
 *
 * Claiming is free and permanent, which is exactly the shape that invites
 * squatting. The cap is per consumer rather than global because the namespace is
 * shared and the scarce thing is a good name, not a row.
 */
export const ALIAS_MAX_PER_CONSUMER = 25;

/** Page size for alias listings, matching the other list endpoints. */
export const ALIAS_PAGE_SIZE = 50;

/**
 * How often expired challenges and recoveries are deleted.
 *
 * Hourly. Nothing waits on the sweep — an expired row is already refused when it
 * is presented — so the interval only bounds how much dead weight builds up
 * between runs, and an indexed `expiresAt` delete is cheap at that volume.
 */
export const ALIAS_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How long past `expiresAt` a challenge or recovery row is kept.
 *
 * A day, so "my claim failed an hour ago" can still be answered from the table —
 * was a challenge issued, was it spent, did it expire. After that the row answers
 * nothing, and a recovery row still holds the owner's mailbox.
 */
export const ALIAS_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Rows per delete statement, and the most one sweep examines per table. The same
 * numbers as the request-log prune, for the same reason: short locks per
 * statement, and a backlog catches up over a few cycles instead of in one long
 * one.
 */
export const ALIAS_SWEEP_BATCH_SIZE = 1000;
export const ALIAS_SWEEP_MAX_PER_CYCLE = 50_000;
