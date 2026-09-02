/** Tuning knobs and policy lists for webhook delivery and destination checks. */

/** How often the sweeper wakes to redeliver failed webhooks. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export const SWEEP_BATCH_SIZE = 25;

export const SWEEP_CONCURRENCY = 5;

/** Total attempts a delivery may accumulate = maxAttempts × this. */
export const RETRY_BUDGET_CYCLES = 3;

/** The claim transaction only selects and stamps; it must not run long. */
export const CLAIM_TIMEOUT_MS = 15_000;

/**
 * Cloud metadata endpoints. They resolve to link-local addresses that the IP
 * checks already reject, but blocking the names too keeps the failure obvious
 * and survives a resolver that answers differently.
 */
export const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.google.com',
  'metadata',
]);
