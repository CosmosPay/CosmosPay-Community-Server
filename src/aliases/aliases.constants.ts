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
 * Wrong-token attempts before a recovery is burned.
 *
 * The token is high-entropy so this is not really a guessing bound — it is a
 * bound on someone using the endpoint as an oracle. Burning the recovery rather
 * than locking the alias is deliberate: the owner starts another one with a fresh
 * email, and an attacker cannot lock a name by failing at it.
 */
export const ALIAS_RECOVERY_MAX_ATTEMPTS = 5;

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
