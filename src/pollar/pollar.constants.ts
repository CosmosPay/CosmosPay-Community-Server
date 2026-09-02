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
