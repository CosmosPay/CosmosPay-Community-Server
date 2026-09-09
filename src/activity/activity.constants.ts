/** Tuning knobs for client activity ingest. */

/**
 * Events accepted in one `POST /v1/activity/events` call.
 *
 * Clients batch: a wallet queues while offline and flushes the backlog on the
 * next launch, so a batch is the normal shape rather than the exceptional one.
 * The cap exists because the whole batch is written in a single statement — one
 * round trip for a hundred rows is the point — and an unbounded array would let
 * one request hold a connection for as long as it liked.
 */
export const ACTIVITY_MAX_BATCH = 100;

/** Longest accepted `message`. Anything longer is truncated, never rejected: a
 *  telemetry call must not fail on the size of an error string. */
export const ACTIVITY_MESSAGE_MAX = 500;

/**
 * Serialized size cap for `props`, in bytes.
 *
 * Over the cap the object is REPLACED by a marker rather than the event being
 * dropped — knowing that `swap.failed` fired matters more than the detail that
 * made it too big, and a client that starts attaching a whole Horizon response
 * should not silently lose its error stream because of it.
 */
export const ACTIVITY_PROPS_MAX_BYTES = 8_192;

/** What `props` becomes when it is over {@link ACTIVITY_PROPS_MAX_BYTES}. */
export const ACTIVITY_PROPS_OVERSIZED = { _dropped: 'props_too_large' };

/**
 * How far ahead of, and behind, the receipt time a client's `occurredAt` may
 * sit before it is clamped to now.
 *
 * The timestamp comes from a device clock, and device clocks are wrong: a phone
 * an hour fast would file every event in the future, where the newest-first list
 * pins it permanently to the top. Behind is the looser bound because a genuinely
 * offline wallet does have days-old events to flush.
 */
export const ACTIVITY_MAX_CLOCK_SKEW_AHEAD_MS = 5 * 60 * 1000;
export const ACTIVITY_MAX_BACKFILL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Ingest budget, per consumer + address.
 *
 * Generous by the standards of the other policies in this service, because a
 * refusal here costs visibility rather than money: a wallet flushing a backlog
 * is doing exactly what it is supposed to. It is still bounded — one consumer
 * must not be able to fill the table on everyone else's behalf.
 */
export const ACTIVITY_INGEST_RATE_LIMIT = {
  name: 'activity:ingest',
  limit: 120,
  windowMs: 60 * 1000,
};

/** Days covered by the default summary window. */
export const ACTIVITY_SUMMARY_DEFAULT_DAYS = 7;

/** Distinct event types / error messages returned in a summary's top lists. */
export const ACTIVITY_SUMMARY_TOP_N = 10;
