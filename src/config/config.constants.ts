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

// --- Pollar (hosted OAuth + virtual Stellar wallets) ---

/** The SDK API, which serves the hosted OAuth flow and the end-user session. */
export const DEFAULT_POLLAR_SDK_BASE_URL = 'https://sdk.api.pollar.xyz';

/** The Server API, which serves the secret-key operator routes. */
export const DEFAULT_POLLAR_SERVER_BASE_URL = 'https://api.pollar.xyz';

/** Upstream budget for one Pollar call. Matches the BlindPay default. */
export const DEFAULT_POLLAR_TIMEOUT_MS = 15_000;

/**
 * How long a bridge handshake may stay open. Pollar's own SDK abandons an
 * interactive login after five minutes (`LOGIN_FLOW_TIMEOUT_MS`), so a handshake
 * that outlives that window is waiting on a session the provider already gave up
 * on.
 */
export const DEFAULT_POLLAR_AUTHORIZATION_TTL_MS = 5 * 60 * 1000;

/**
 * How long a minted bridge code stays redeemable. Short on purpose: the code
 * travels through the browser (redirect) or a poll, and its only job is to
 * survive the hop from the callback to the wallet's next request.
 */
export const DEFAULT_POLLAR_CODE_TTL_MS = 2 * 60 * 1000;

/**
 * How long redemption waits for Pollar to finish resolving the user's wallet.
 * Pollar runs five steps after the provider callback (validate session, resolve
 * wallet, fund the reserve, add trustlines, mint the JWT), and a first login
 * that has to create and fund an account is the slow case.
 */
export const DEFAULT_POLLAR_LOGIN_WAIT_MS = 20_000;

/** Sweeper cadence for expiring stale handshakes. */
export const DEFAULT_POLLAR_SWEEP_INTERVAL_MS = 60_000;
