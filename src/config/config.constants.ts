/** Defaults applied when the corresponding environment variable is unset. */
import type { StellarNetwork } from '@/config/configuration';

export const DEFAULT_SWAP_FEE_BPS = 50;
export const DEFAULT_SWAP_SLIPPAGE_BPS = 50;
export const DEFAULT_SWAP_MAX_SLIPPAGE_BPS = 500;

/** Public Horizon endpoints, per network. */
export const DEFAULT_HORIZON: Record<StellarNetwork, string> = {
  public: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org',
};

// --- Rate limiting ---

/**
 * How often rolled-over rate-limit windows are deleted. Ten minutes: the table
 * only ever holds live and just-expired windows, so there is no backlog to race
 * and no reason to wake up more often than that.
 */
export const DEFAULT_RATE_LIMIT_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Upstream budget for one call to Google or GitHub during a wallet sign-in.
 *
 * Short: these are a token exchange and a profile read
 * against two of the most available endpoints on the internet, and the person is
 * watching a spinner in a browser that just came back from a consent screen.
 */
export const DEFAULT_WALLET_AUTH_TIMEOUT_MS = 10_000;

/** Sweeper cadence for expiring stale sign-in handshakes and login codes. */
export const DEFAULT_WALLET_AUTH_SWEEP_INTERVAL_MS = 60_000;

/** How long a recovery server waits on Horizon, the OIDC provider or the mailer. */
export const DEFAULT_RECOVERY_TIMEOUT_MS = 10_000;

/** Sweeper cadence for expired recovery codes and spent ID-token records. */
export const DEFAULT_RECOVERY_SWEEP_INTERVAL_MS = 60_000;

/**
 * Stellar's public network passphrase, spelled out rather than imported so this
 * data-only module takes no runtime dependency on the SDK. Pinned against the
 * SDK's `Networks.PUBLIC` in `identity-env.spec.ts`.
 */
export const NETWORK_PASSPHRASE_PUBLIC =
  'Public Global Stellar Network ; September 2015';

/** DeFindex's hosted API, used when `DEFINDEX_BASE_URL` is unset. */
export const DEFAULT_DEFINDEX_BASE_URL = 'https://api.defindex.io';

/**
 * Upstream budget for one DeFindex call. Building a vault deposit simulates a
 * Soroban transaction on DeFindex's side, which is slower than a plain read.
 */
export const DEFAULT_DEFINDEX_TIMEOUT_MS = 30_000;
