/**
 * Prefix of every APISIX consumer this service creates.
 *
 * It starts with the developer platform's own `cosmos_` so the dashboard's
 * helpers read it as one of theirs, and it is the ONLY prefix the admin client
 * here will write under: the admin key can do anything to the gateway, so the
 * client refuses every consumer name outside this namespace rather than trusting
 * each call site to pass the right one.
 */
export const WALLET_CONSUMER_PREFIX = 'cosmos_wallet_';

/** Prefix of the credential ids minted under a wallet consumer. */
export const WALLET_CREDENTIAL_PREFIX = 'cosmos_wk_';

/**
 * Scopes on a wallet account's keys — the same set the platform used to mint.
 *
 * The wallet's only credential is this key, so a scope missing here is a
 * feature that dies on its first call with `insufficient_scope`, which reads to
 * the person like a broken install. `activity:read` is what lets them see their
 * own telemetry in the dashboard: a wallet account has no other key to mint.
 */
export const WALLET_KEY_SCOPES = [
  'swaps:read',
  'swaps:write',
  'liquidity:read',
  'liquidity:write',
  'payments:read',
  'payments:write',
  'kyc:read',
  'kyc:write',
  'onramp:read',
  'onramp:write',
  'offramp:read',
  'offramp:write',
  'activity:read',
  'activity:write',
] as const;

/**
 * The plan a wallet account is on. The platform provisioned every wallet as
 * `community`, and a plan change is something the platform does, not this
 * service — the forwarder bakes whatever it was given at mint time.
 */
export const WALLET_KEY_PLAN = 'community';

/**
 * Swap commission baked for a wallet account's keys, in basis points: the
 * `community` plan's rate in the platform's plan table. Overridable with
 * `WALLET_KEY_SWAP_FEE_BPS` so a self-hosted deployment is not bound to it.
 */
export const DEFAULT_WALLET_KEY_SWAP_FEE_BPS = 50;

/** Upstream budget for one call to the APISIX Admin API. */
export const DEFAULT_APISIX_ADMIN_TIMEOUT_MS = 10_000;

/** Shape of a key the platform and this service mint: `dv_` / `prod_` + 64 hex. */
export const GATEWAY_KEY_RE = /^(dv|prod)_[0-9a-f]{64}$/;

/**
 * Characters a value may have to be baked into the forwarder's Lua long string.
 * Scopes, ids, the plan and emails all fit; anything else is dropped rather than
 * escaped, so nothing can close the `]==]` it is embedded in.
 */
export const LUA_SAFE_RE = /^[A-Za-z0-9:_.\-@%+]+$/;
