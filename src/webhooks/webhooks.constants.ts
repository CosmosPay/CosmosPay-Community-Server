/** Tuning knobs and policy lists for webhook delivery and destination checks. */

/** How often the sweeper wakes to redeliver failed webhooks. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export const SWEEP_BATCH_SIZE = 25;

export const SWEEP_CONCURRENCY = 5;

/** Total attempts a delivery may accumulate = maxAttempts × this. */
export const RETRY_BUDGET_CYCLES = 3;

/** The claim transaction only selects and stamps; it must not run long. */
export const CLAIM_TIMEOUT_MS = 15_000;

// --- Rate limits -----------------------------------------------------------
//
// What is being defended: both routes below make this service send signed HTTPS
// requests, on demand, to a URL the caller chose. The destination policy keeps
// that URL public, but a public host can still be someone else's, so without a
// cap these routes let a key aim this service's egress at a third party, in a
// loop. Each call also holds a request slot for as long as the far end takes to
// answer. Budgets are per consumer + client address, and the fixed window means
// the true ceiling is twice these numbers across a boundary.

/** One window for both, the same span the Pollar and alias budgets use. */
const WEBHOOK_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/**
 * `POST /v1/webhooks/:id/ping`: one outbound POST per call.
 *
 * Twenty covers a developer re-pinging after every change to their signature
 * check, which is the job this route does. A flood needs far more than that. The
 * bucket is shared across all of a consumer's endpoints, so registering more
 * endpoints does not buy more pings.
 */
export const WEBHOOK_PING_RATE_LIMIT = {
  name: 'webhooks:ping',
  limit: 20,
  windowMs: WEBHOOK_RATE_LIMIT_WINDOW_MS,
};

/**
 * `POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver`: up to
 * `WEBHOOK_MAX_ATTEMPTS` outbound POSTs per call.
 *
 * The retry loop runs inline, so a single call can send several requests and hold
 * the handler through the connect and read timeouts plus the jittered backoff
 * between attempts. That is up to half a minute at the defaults. The budget is
 * looser than ping's because replaying a handful of deliveries after an outage is
 * normal use. It is not meant for replaying a whole backlog: the sweeper already
 * retries stranded deliveries, and an integrator that missed more than this should
 * reconcile against the API.
 */
export const WEBHOOK_REDELIVER_RATE_LIMIT = {
  name: 'webhooks:redeliver',
  limit: 30,
  windowMs: WEBHOOK_RATE_LIMIT_WINDOW_MS,
};

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
