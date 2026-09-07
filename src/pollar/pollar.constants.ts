/**
 * Protocol facts and policy knobs for the Pollar integration.
 *
 * Values that come from the environment live in `src/config/configuration.ts`,
 * and their fallbacks in `src/config/config.constants.ts`. What is here is the
 * shape of Pollar's own API and the bridge's own policy.
 */

/**
 * Pollar splits its API in two, and they do not share a key.
 *
 * The **SDK API** serves the end-user surface — the hosted OAuth redirect, the
 * client session, `/auth/login` — and is authenticated with the *publishable*
 * key. The **Server API** serves operator routes (activate a wallet, add a
 * trustline, register a user, verify a token) and is authenticated with the
 * *secret* key. Sending the wrong key type to either is a hard
 * `API_KEY_TYPE_NOT_ALLOWED` rejection, so the client keeps them apart.
 */
export const POLLAR_SDK_API_VERSION = 'v2';
export const POLLAR_SERVER_API_VERSION = 'v1';

/** Pollar authenticates with its own header, not `Authorization`. */
export const POLLAR_API_KEY_HEADER = 'x-pollar-api-key';

/** The hosted OAuth providers `GET /auth/{provider}` serves today. */
export const POLLAR_OAUTH_PROVIDERS = ['google', 'github'] as const;
export type PollarOauthProvider = (typeof POLLAR_OAUTH_PROVIDERS)[number];

/**
 * Pollar's network names. Ours are Stellar's (`public` / `testnet`); Pollar
 * calls the same two `mainnet` / `testnet`, and stamps them into the API key
 * prefix (`pub_mainnet_`, `sec_testnet_`), so the mapping has to be explicit.
 */
export const POLLAR_NETWORK_BY_STELLAR = {
  public: 'mainnet',
  testnet: 'testnet',
} as const;

/** Expected prefixes per key type and network, checked at boot. */
export const POLLAR_KEY_PREFIX = {
  publishable: { public: 'pub_mainnet_', testnet: 'pub_testnet_' },
  secret: { public: 'sec_mainnet_', testnet: 'sec_testnet_' },
} as const;

/**
 * The client-session status that means "Pollar finished the provider handshake
 * and the session can be redeemed for tokens". Anything else is still in
 * flight; 404/410 on the status route are terminal.
 */
export const POLLAR_SESSION_READY = 'READY';

/** Gap between status polls while waiting for a session to become ready. */
export const POLLAR_SESSION_POLL_INTERVAL_MS = 500;

/**
 * How stale a handshake's last provider check may be before the poll route asks
 * Pollar again.
 *
 * The poll is the only thing that ever learns a login finished — Pollar leaves
 * the client session `READY` and never calls the bridge back — and a wallet
 * repeats it every few seconds while the consent screen is open. Without a floor
 * each waiting wallet would spend one Pollar request per poll, against a key
 * whose whole budget is 200 a minute. Two seconds keeps discovery within a
 * single poll of the truth and caps a waiting wallet at 30 requests a minute.
 */
export const POLLAR_SESSION_PROBE_INTERVAL_MS = 2_000;

/**
 * Budget for that check, far below the client's default. The wallet asking is
 * coming back in a few seconds anyway, so a provider that has not answered by
 * here has nothing left to say that *this* poll can use — and holding the poll
 * open for the full client timeout would stall the wallet's own loop.
 */
export const POLLAR_SESSION_PROBE_TIMEOUT_MS = 3_000;

/**
 * Entropy of the bridge's own handles. 32 bytes for both: `state` is the public
 * name of a handshake and must not be guessable by anyone who can reach the
 * callback, and `code` is a bearer credential for a Pollar session.
 */
export const POLLAR_STATE_BYTES = 32;
export const POLLAR_CODE_BYTES = 32;

/** PKCE (RFC 7636). S256 only — `plain` offers no protection over a redirect. */
export const POLLAR_PKCE_METHOD = 'S256';

/**
 * Hosts that count as a loopback redirect target. A native wallet listens on an
 * ephemeral port here to catch the code, so the allow-list matches the host and
 * lets the port float (RFC 8252 §7.3).
 */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/**
 * Pollar client-session status codes that can never become ready. The bridge
 * turns these into a terminal handshake rather than waiting out the budget.
 */
export const POLLAR_TERMINAL_SESSION_CODES = new Set([
  'INVALID_CLIENT_SESSION_ID',
  'EXPIRED_CLIENT_ID',
]);

/**
 * Handshakes expired per sweeper tick. Small on purpose: the table only ever
 * holds logins currently in flight, so a backlog means an incident, not load,
 * and a bounded `updateMany` keeps each tick's lock short either way.
 */
export const POLLAR_SWEEP_BATCH_SIZE = 500;

// --- Rate limits -----------------------------------------------------------
//
// What is actually being defended: creating a Pollar wallet is not free. Pollar
// creates the Stellar account, funds its base reserve (1 XLM) and adds a
// trustline per configured asset (0.5 XLM each) — all out of the operator's
// funding wallet. A loop calling the login flow is therefore a way to spend
// somebody else's money, and it does not need a valid user at the end of it to
// do damage.
//
// The control point is `authorize`, not `token`. A handshake can yield at most
// one wallet, so capping how many handshakes an address may open caps how many
// wallets it can cause — while `token` has to stay loose enough for the retry
// the 409 path explicitly asks for. Budgets are per address (per /64 on IPv6)
// per consumer; remember the fixed window means the true ceiling is twice these
// numbers across a boundary.

/** One window for all of it: long enough to bound a burst, short enough that a
 *  user who genuinely fumbled a login is not locked out for the afternoon. */
const WINDOW_MS = 10 * 60 * 1000;

/**
 * Opening a login. **This is the cap on wallet generation** — every wallet this
 * service can cause to exist starts with one of these. Twenty is far above a
 * human retrying a failed consent screen and far below a rate that could drain
 * a funded account.
 */
export const POLLAR_AUTHORIZE_RATE_LIMIT = {
  name: 'pollar:authorize',
  limit: 20,
  windowMs: WINDOW_MS,
};

/**
 * Redeeming a code. Deliberately looser than `authorize`: a first login legitimately
 * returns 409 while Pollar provisions the wallet and the caller is told to retry
 * the same code, so a tight budget here would throttle our own documented retry.
 * It creates nothing new anyway — the handshake it redeems was already counted.
 */
export const POLLAR_TOKEN_RATE_LIMIT = {
  name: 'pollar:token',
  limit: 60,
  windowMs: WINDOW_MS,
};

/**
 * The public callback. The only route here reachable without an API key, so it
 * is the one an anonymous flood can reach. Generous, because a user refreshing
 * the tab is normal and each hit is a single indexed read plus at most one
 * compare-and-swap.
 */
export const POLLAR_CALLBACK_RATE_LIMIT = {
  name: 'pollar:callback',
  limit: 60,
  windowMs: WINDOW_MS,
};

/**
 * Provisioning a wallet directly, with no user in the loop at all. The tightest
 * of the set: there is no consent screen pacing it, so the limit is the only
 * thing standing between a script and the funding wallet.
 */
export const POLLAR_PROVISION_RATE_LIMIT = {
  name: 'pollar:provision',
  limit: 10,
  windowMs: WINDOW_MS,
};

/**
 * Funding an existing wallet's reserve. Spends XLM per call like the routes
 * above, but cannot create anything new, so it sits between the two.
 */
export const POLLAR_ACTIVATE_RATE_LIMIT = {
  name: 'pollar:activate',
  limit: 20,
  windowMs: WINDOW_MS,
};

// --- Cross-network wallet provisioning -------------------------------------
//
// A hosted login produces a wallet on exactly one network: Pollar runs mainnet
// and testnet as two separate applications with two separate key pairs, and the
// client session belongs to one of them. So after a redemption the bridge asks
// the *other* network's Server API to register the same user with a wallet.
//
// That second call is best-effort by design. It spends the operator's XLM, it
// talks to an API that may be down, and it may have no key configured at all —
// none of which is a reason to fail a login that already succeeded. A failure
// leaves the row PENDING and the sweeper picks it up.

/**
 * Budget for the counterpart call made *inside* a redemption. Much shorter than
 * `POLLAR_TIMEOUT_MS`: the user is waiting on a login that has already worked,
 * and the whole point is that this attempt is optional. When it does not fit in
 * five seconds the row stays PENDING and the sweeper finishes the job off the
 * request path.
 */
export const POLLAR_WALLET_PROVISION_TIMEOUT_MS = 5_000;

/**
 * Total attempts across every sweep, not per cycle. Pollar refusing the same
 * registration ten times is a configuration problem — a missing key, a rejected
 * email — that another attempt will not fix, and the row goes FAILED so the
 * sweeper stops spending a request on it every minute.
 */
export const POLLAR_WALLET_PROVISION_MAX_ATTEMPTS = 10;

/**
 * Base of the exponential backoff between attempts, doubled per attempt and
 * capped by {@link POLLAR_WALLET_PROVISION_MAX_BACKOFF_MS}. The first retry is a
 * minute out because the common failure is "the operator has not configured the
 * other network's keys yet", which is fixed on a human timescale, not a
 * millisecond one.
 */
export const POLLAR_WALLET_PROVISION_BACKOFF_MS = 60_000;

/** Ceiling on that backoff, so a long-failing row is still retried hourly. */
export const POLLAR_WALLET_PROVISION_MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Rows claimed per sweep. Small like the handshake sweeper's, and for the same
 * reason: this table only holds provisioning that has not landed yet, so a
 * backlog means an incident rather than load.
 */
export const POLLAR_WALLET_PROVISION_BATCH_SIZE = 50;

/**
 * Registrations in flight at once during a sweep. Each one funds a reserve on
 * Pollar's side, so the batch is drained in small groups rather than fired at
 * the provider all at once.
 */
export const POLLAR_WALLET_PROVISION_CONCURRENCY = 4;

/**
 * How long the claim transaction may hold the advisory lock. The sweep's
 * network I/O happens outside it — see the sweeper's `cycle` override — so this
 * only has to cover a bounded `findMany` plus one `updateMany`.
 */
export const POLLAR_WALLET_PROVISION_CLAIM_TIMEOUT_MS = 10_000;

/**
 * Pollar result codes that mean "this user already exists on this network".
 * They are a success for our purposes — the wallet we were asking for is there —
 * so they resolve the row instead of burning an attempt on it.
 */
export const POLLAR_USER_EXISTS_CODES = new Set([
  'USER_ALREADY_EXISTS',
  'EXTERNAL_ID_ALREADY_EXISTS',
  'SERVER_USER_ALREADY_REGISTERED',
]);
