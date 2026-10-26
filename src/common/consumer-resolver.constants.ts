/** Tuning for `ConsumerResolverService.resolveId`, the read paths' consumer lookup. */

/**
 * How long a gateway consumer's local id is reused before the row is upserted again. The
 * mirror row only ever gains a `credentialId` (part of the key below, so a new credential is
 * upserted at once) and is never deleted, so its id cannot go stale; the minute only bounds the
 * memory and re-checks the row now and then. Before it, every dashboard read paid an upsert (a
 * write and a row lock) just to learn an id it already had.
 */
export const CONSUMER_ID_CACHE_TTL_MS = 60_000;

/** Distinct consumers whose id is held at once; the least recently used goes first. */
export const CONSUMER_ID_CACHE_MAX_ENTRIES = 5_000;
