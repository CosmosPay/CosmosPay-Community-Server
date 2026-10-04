/** Defaults applied when the corresponding environment variable is unset. */
import type { StellarNetwork } from '@/config/configuration';

/**
 * The file the environment is read from when `ENV_FILE` is unset. Local instances
 * beside the first (`npm run dev:local`) read it too, with their differences
 * already in the environment.
 */
export const DEFAULT_ENV_FILE = '.env';

export const DEFAULT_SWAP_FEE_BPS = 50;
export const DEFAULT_SWAP_SLIPPAGE_BPS = 50;
export const DEFAULT_SWAP_MAX_SLIPPAGE_BPS = 500;

/** Public Horizon endpoints, per network. */
export const DEFAULT_HORIZON: Record<StellarNetwork, string> = {
  public: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org',
};

/**
 * Public Solana RPC endpoints, per network tier (`public` → mainnet-beta,
 * `testnet` → devnet). Rate-limited hard: fine for a trial, not for production
 * traffic — set `SOLANA_RPC_URL_MAINNET` to a provider's endpoint.
 */
export const DEFAULT_SOLANA_RPC: Record<StellarNetwork, string> = {
  public: 'https://api.mainnet-beta.solana.com',
  testnet: 'https://api.devnet.solana.com',
};

/** Monad's public RPC endpoints, per network tier (mainnet, testnet). */
export const DEFAULT_MONAD_RPC: Record<StellarNetwork, string> = {
  public: 'https://rpc.monad.xyz',
  testnet: 'https://testnet-rpc.monad.xyz',
};

/**
 * Budget for one JSON-RPC call to Solana or Monad. A single read (a
 * transaction, a block number, a page of logs) — slower than that is an RPC
 * provider in trouble, and the observer retries on its next tick.
 */
export const DEFAULT_CHAIN_RPC_TIMEOUT_MS = 10_000;

/**
 * Blocks one `eth_getLogs` may span. Monad's public RPC refuses anything wider
 * ("eth_getLogs is limited to a 100 range"); a paid provider usually allows
 * more, and raising it lets the observer catch up in fewer calls.
 */
export const DEFAULT_MONAD_LOG_BLOCK_RANGE = 100;

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

/** Stellar's test network passphrase, pinned the same way. */
export const NETWORK_PASSPHRASE_TESTNET = 'Test SDF Network ; September 2015';

/** Each network's passphrase, for defaults that follow `STELLAR_NETWORK`. */
export const NETWORK_PASSPHRASE: Record<StellarNetwork, string> = {
  public: NETWORK_PASSPHRASE_PUBLIC,
  testnet: NETWORK_PASSPHRASE_TESTNET,
};

/** DeFindex's hosted API, used when `DEFINDEX_BASE_URL` is unset. */
export const DEFAULT_DEFINDEX_BASE_URL = 'https://api.defindex.io';

/**
 * Upstream budget for one DeFindex call. Building a vault deposit simulates a
 * Soroban transaction on DeFindex's side, which is slower than a plain read.
 */
export const DEFAULT_DEFINDEX_TIMEOUT_MS = 30_000;

/** The NEAR Intents 1Click API, used when `NEAR_INTENTS_BASE_URL` is unset. */
export const DEFAULT_NEAR_INTENTS_BASE_URL = 'https://1click.chaindefuser.com';

/**
 * Upstream budget for one 1Click call. A live quote asks the solver network for
 * a price and derives a deposit address, which takes a few seconds on a good
 * day; slower than this is 1Click in trouble, and the caller gets a 504.
 */
export const DEFAULT_NEAR_INTENTS_TIMEOUT_MS = 20_000;

/**
 * Default slippage for a cross-chain swap, in bps. Higher than a Stellar path
 * payment's: the price is fixed at quote time but the swap settles after the
 * deposit confirms on the origin chain, and 1Click refunds rather than fills
 * below the minimum — so a tight default refunds honest swaps in a moving market.
 */
export const DEFAULT_CROSS_CHAIN_SLIPPAGE_BPS = 100;

/** The most slippage a caller may ask for on a cross-chain swap, in bps. */
export const DEFAULT_CROSS_CHAIN_MAX_SLIPPAGE_BPS = 500;

/**
 * How long a cross-chain deposit address accepts the deposit, in seconds. Half
 * an hour covers a wallet round-trip on Stellar, Solana and Monad, which all
 * finalize in seconds; past it 1Click refunds whatever arrives.
 */
export const DEFAULT_CROSS_CHAIN_DEADLINE_SECONDS = 30 * 60;

/** Jupiter's Swap API, used when `JUPITER_BASE_URL` is unset: the keyless tier. */
export const DEFAULT_JUPITER_BASE_URL = 'https://lite-api.jup.ag/swap/v1';

/** Kuru Flow's API (Monad), used when `KURU_BASE_URL` is unset. */
export const DEFAULT_KURU_BASE_URL = 'https://ws.kuru.io';

/**
 * Upstream budget for one aggregator call (Jupiter or Kuru Flow). A quote is a
 * route search and a swap build simulates the transaction; both answer in well
 * under a second when healthy.
 */
export const DEFAULT_SWAP_AGGREGATOR_TIMEOUT_MS = 15_000;
