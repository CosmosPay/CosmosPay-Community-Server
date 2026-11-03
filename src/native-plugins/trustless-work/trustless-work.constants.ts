import type { RateLimitPolicy } from '@/common/decorators/rate-limit.decorator';

// ── Trustless Work's contract and API ───────────────────────────────────────

/**
 * Trustless Work's own fee, in basis points: 0.30%, hard-coded in the V1
 * single-release contract (`TRUSTLESS_WORK_FEE_BPS` in its fee calculator) and
 * deducted on-chain from every release and every dispute distribution. Not a
 * setting: changing it here would only make this service's fee math disagree
 * with what the chain pays.
 */
export const TRUSTLESS_WORK_FEE_BPS = 30;

/** The contract's basis-point denominator (`BASIS_POINTS_DENOMINATOR`). */
export const TRUSTLESS_WORK_BPS_DENOMINATOR = 10_000n;

/**
 * The asset a protected payment is held in. USDC only (product owner,
 * 2026-11-02): the issuer comes from the asset registry for the network, and
 * the contract's trustline is that asset's Stellar Asset Contract.
 */
export const PROTECTED_PAYMENT_ASSET_CODE = 'USDC';

/**
 * The deployer entry point a deploy envelope must call, and the init function
 * it must hand the new contract (V1 single release, branch `single-release-main`).
 */
export const TRUSTLESS_WORK_DEPLOY_FN = 'tw_new_single_release_escrow';
export const TRUSTLESS_WORK_INIT_FN = 'initialize_escrow';

/**
 * The one milestone every protected payment has: index 0, the delivery. A
 * single-release contract releases everything at once when all its milestones
 * are approved, so one milestone is the whole order.
 */
export const PROTECTED_PAYMENT_MILESTONE_INDEX = 0;

/** The milestone's text in the contract. Shown by Trustless Work's own tools. */
export const PROTECTED_PAYMENT_MILESTONE_DESCRIPTION = 'Order delivered';

/**
 * The milestone status the merchant's ship call writes. The contract treats
 * the status as free text; the sync job reads a milestone as shipped when it
 * carries this status or any evidence.
 */
export const PROTECTED_PAYMENT_SHIPPED_STATUS = 'shipped';

/**
 * The longest a milestone status string the API writes at deploy may be. The
 * check is tolerant on that one string (the V1 docs spell it `pending` and
 * `peding`, and nothing in it moves money); this only keeps it from being a
 * payload.
 */
export const TRUSTLESS_WORK_MAX_STATUS_LENGTH = 32;

/**
 * Contract ids per `get-escrow-by-contract-ids` call: the contract's own
 * `MAX_ESCROWS` for a multi-balance read, and a URL that stays short.
 */
export const TRUSTLESS_WORK_READ_BATCH = 20;

/**
 * Trustless Work reads one sync cycle may spend. The API allows 50 requests per
 * 60 s per key, shared with every build and submit of the deployment; five reads
 * every 30 s (100 contracts) leaves most of that budget to the routes.
 */
export const PROTECTED_PAYMENT_SYNC_MAX_READS = 5;

// ── Envelopes ──────────────────────────────────────────────────────────────

/**
 * The longest a built protected-payment transaction stays submittable, from
 * the build, and the furthest its `maxTime` may be: DeFindex's fifteen minutes,
 * the window the wallet accepts for a Soroban envelope, long enough for a
 * hardware wallet or a SEP-7 signature on a phone.
 */
export const TRUSTLESS_WORK_BUILD_TTL_MS = 15 * 60 * 1000;

/**
 * Clock difference allowed between this service and Trustless Work on an
 * envelope's time bounds, both ways.
 */
export const TRUSTLESS_WORK_CLOCK_SKEW_MS = 60 * 1000;

/**
 * How long a submit holds its claim on a built transaction beyond the
 * Trustless Work timeout before another submit may take it over. A process
 * that died mid-submit would otherwise leave it claimed forever; taking it over
 * can only resend the same transaction, which lands at most once.
 */
export const TRUSTLESS_WORK_SUBMIT_LEASE_MARGIN_MS = 30 * 1000;

/**
 * How many Trustless Work calls a deploy spans while it holds its claim on the
 * protected payment: the build and the relay. The claim's lease is that many
 * timeouts plus {@link TRUSTLESS_WORK_SUBMIT_LEASE_MARGIN_MS}; two fund calls
 * at once must never deploy two contracts.
 */
export const PROTECTED_PAYMENT_DEPLOY_CALLS = 2;

// ── The product ────────────────────────────────────────────────────────────

/**
 * The smallest protected payment, in USDC. Every one costs the platform a
 * contract deploy in XLM, and the contract's fees round down per distribution:
 * below one dollar the 1.65% does not pay for the deploy.
 */
export const PROTECTED_PAYMENT_MIN_AMOUNT = '1';

/**
 * The largest protected payment, in USDC. Trustless Work's API takes the amount
 * as a JSON number, which carries the 7 decimals exactly only well below
 * 2^53 / 10^7; a cap also bounds what one leaked key can move per payment.
 */
export const PROTECTED_PAYMENT_MAX_AMOUNT = '1000000';

/**
 * Bounds on the delivery window, in hours: at least one, at most 90 days, the
 * longest a merchant should keep a buyer's money waiting.
 */
export const PROTECTED_PAYMENT_MIN_DELIVERY_HOURS = 1;
export const PROTECTED_PAYMENT_MAX_DELIVERY_HOURS = 2160;

/**
 * How long the buyer has to fund, in hours, when the merchant names none:
 * three days, a weekend plus a working day. At most 30 days.
 */
export const PROTECTED_PAYMENT_DEFAULT_FUNDING_HOURS = 72;
export const PROTECTED_PAYMENT_MAX_FUNDING_HOURS = 720;

/** Text bounds: they go on-chain (title, description) or into one row. */
export const PROTECTED_PAYMENT_MAX_TITLE = 100;
export const PROTECTED_PAYMENT_MAX_DESCRIPTION = 500;
export const PROTECTED_PAYMENT_MAX_REFERENCE = 128;
export const PROTECTED_PAYMENT_MAX_EVIDENCE = 500;
export const PROTECTED_PAYMENT_MAX_REASON = 500;

/**
 * The first line of the message a buyer signs to have the platform open a
 * dispute for them (a `MERCHANT_RELEASES` payment gives the buyer no on-chain
 * role). A line of its own, so the signature is worth nothing to any other
 * flow, and no Stellar transaction envelope can start with it.
 */
export const PROTECTED_PAYMENT_DISPUTE_CHALLENGE_TITLE =
  'Cosmos Pay protected payment dispute';

/**
 * How far ahead a dispute challenge's expiry may be. It is what bounds a
 * replay of a signature someone saw: ten minutes is a buyer reading the
 * message in a wallet and signing it.
 */
export const PROTECTED_PAYMENT_DISPUTE_CHALLENGE_TTL_MS = 10 * 60 * 1000;

// ── Background jobs ────────────────────────────────────────────────────────

/** How often the sync job reads open contracts back through Trustless Work. */
export const PROTECTED_PAYMENT_SYNC_INTERVAL_MS = 30 * 1000;

/** How often unfunded protected payments past their funding window expire. */
export const PROTECTED_PAYMENT_EXPIRY_INTERVAL_MS = 60 * 1000;

/** How often the deadline job looks for funded payments past their delivery deadline. */
export const PROTECTED_PAYMENT_DEADLINE_INTERVAL_MS = 60 * 1000;

/**
 * Rows the expiry and deadline jobs take per cycle. Each auto-policy deadline
 * spends up to four Trustless Work calls (build and relay, twice), so twenty
 * stays inside the API's per-minute budget with room for the routes.
 */
export const PROTECTED_PAYMENT_JOB_BATCH = 20;

/**
 * How many Trustless Work timeouts a job cycle may hold its advisory lock
 * transaction for: every row in it can be a round trip.
 */
export const PROTECTED_PAYMENT_JOB_LOCK_TIMEOUT_MULTIPLIER = 10;

// ── Budgets ────────────────────────────────────────────────────────────────

/**
 * `POST /v1/protected-payments`, per consumer + client address. A create calls
 * nobody, but each payment can cost the platform a contract deploy later: thirty
 * a minute is a busy shop, not a script.
 */
export const PROTECTED_PAYMENT_CREATE_RATE_LIMIT: RateLimitPolicy = {
  name: 'protected-payments:create',
  limit: 30,
  windowMs: 60 * 1000,
};

/**
 * The merchant's builds (ship, approve, release, dispute), per consumer +
 * client address. Each is a Trustless Work call on the deployment's key (a
 * quota every tenant shares) and a row the submit is checked against; twenty a
 * minute matches DeFindex's builds.
 */
export const PROTECTED_PAYMENT_BUILD_RATE_LIMIT: RateLimitPolicy = {
  name: 'protected-payments:build',
  limit: 20,
  windowMs: 60 * 1000,
};

/** `POST /v1/protected-payments/submit`: every accepted one is a relay on the shared key. */
export const PROTECTED_PAYMENT_SUBMIT_RATE_LIMIT: RateLimitPolicy = {
  name: 'protected-payments:submit',
  limit: 20,
  windowMs: 60 * 1000,
};

/**
 * `GET /v1/protected-payment-links/{id}`, per client address. `@Public()`, so
 * the address is the whole budget (never `per: 'consumer'`: every caller is
 * the same anonymous subject). The checkout page polls; sixty a minute is
 * `PAYMENT_LINK_READ_RATE_LIMIT`'s five tabs' worth.
 */
export const PROTECTED_PAYMENT_LINK_READ_RATE_LIMIT: RateLimitPolicy = {
  name: 'protected-payment-links:read',
  limit: 60,
  windowMs: 60 * 1000,
};

/**
 * The buyer's builds (fund, approve, release, dispute), per client address.
 * The first fund deploys a contract with the platform's XLM, once per payment;
 * ten a minute is a buyer retrying a wallet that timed out.
 */
export const PROTECTED_PAYMENT_LINK_BUILD_RATE_LIMIT: RateLimitPolicy = {
  name: 'protected-payment-links:build',
  limit: 10,
  windowMs: 60 * 1000,
};

/** The buyer's submit, per client address: a relay on the shared Trustless Work key. */
export const PROTECTED_PAYMENT_LINK_SUBMIT_RATE_LIMIT: RateLimitPolicy = {
  name: 'protected-payment-links:submit',
  limit: 20,
  windowMs: 60 * 1000,
};
