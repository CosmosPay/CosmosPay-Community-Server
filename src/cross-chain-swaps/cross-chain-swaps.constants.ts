/** Constants for cross-chain swaps settled by NEAR Intents. */

import type { SwapChain } from '@/chains/chains.constants';
import {
  EVM_TX_ID_RE,
  SOLANA_TX_ID_RE,
  TX_HASH_RE,
} from '@/payment-intents/payment-intents.constants';

/**
 * Where a pair with both legs on one chain is settled, per chain.
 *
 * A name is the venue `/v1/swaps` routes that chain's swaps to — an
 * aggregator searching every liquidity source there, which beats a bridge
 * round-trip — and this module refuses the pair, pointing at it. `null` is a
 * chain this service has no venue on: Ethereum, Arbitrum and Base, whose
 * same-chain pairs (ETH → USDC on Arbitrum) NEAR Intents settles here like any
 * other, and Bitcoin, whose one asset makes every same-chain pair the same
 * asset, refused as such.
 */
/**
 * The chains whose same-chain venue is a third party that can be down — Jupiter,
 * Kuru Flow — and so may hand a pair to NEAR Intents when the client asks
 * (`venueFallback`). The Stellar DEX is part of the network: when it cannot
 * be reached, neither can anything else on Stellar.
 */
export const VENUE_FALLBACK_CHAINS: readonly SwapChain[] = ['solana', 'monad'];

export const SAME_CHAIN_VENUES: Record<SwapChain, string | null> = {
  stellar: 'the Stellar DEX',
  solana: 'Jupiter',
  monad: 'Kuru Flow',
  ethereum: null,
  arbitrum: null,
  base: null,
  bitcoin: null,
};

/**
 * A Bitcoin transaction id: 32 bytes in hex, no prefix — the byte-reversed
 * double SHA-256 that explorers and wallets display.
 */
export const BITCOIN_TX_ID_RE = /^[0-9a-fA-F]{64}$/;

/** How an origin chain spells a deposit transaction id. */
export interface DepositTxIdRule {
  pattern: RegExp;
  /**
   * Hex: stored lowercase, as everywhere else in this service. Off for a
   * base58 Solana signature, which is case-sensitive and stored as given.
   */
  lowercase: boolean;
}

/** {@link DepositTxIdRule} per origin chain, for `POST /{id}/deposit`. */
export const CROSS_CHAIN_DEPOSIT_TX_IDS: Record<SwapChain, DepositTxIdRule> = {
  stellar: { pattern: TX_HASH_RE, lowercase: true },
  solana: { pattern: SOLANA_TX_ID_RE, lowercase: false },
  monad: { pattern: EVM_TX_ID_RE, lowercase: true },
  ethereum: { pattern: EVM_TX_ID_RE, lowercase: true },
  arbitrum: { pattern: EVM_TX_ID_RE, lowercase: true },
  base: { pattern: EVM_TX_ID_RE, lowercase: true },
  bitcoin: { pattern: BITCOIN_TX_ID_RE, lowercase: true },
};

/**
 * Budget for `POST /v1/cross-chain-swaps/quote`, per consumer + client address.
 *
 * A quote persists nothing here, but it is a solver auction at 1Click, and every
 * call this service makes counts against the one partner key the whole
 * deployment shares. The route takes the shared public key, so a wallet polling
 * a price in a loop would spend that budget for every anonymous caller at once.
 * Sixty a minute is a price refreshed once a second — as fast as anyone reads one.
 */
export const CROSS_CHAIN_QUOTE_RATE_LIMIT = {
  name: 'cross-chain-swaps:quote',
  limit: 60,
  windowMs: 60 * 1000,
};

/**
 * Budget for `POST /v1/cross-chain-swaps`, per consumer + client address.
 *
 * Each create is a live 1Click quote that derives a deposit address, a row this
 * service polls until the swap settles or the deadline plus
 * {@link CROSS_CHAIN_RESCUE_WINDOW_MS} passes, and a webhook. Twenty a minute is
 * several honest swaps started at once from one address; a builder that never
 * deposits is bounded the same way.
 */
export const CROSS_CHAIN_CREATE_RATE_LIMIT = {
  name: 'cross-chain-swaps:create',
  limit: 20,
  windowMs: 60 * 1000,
};

/**
 * Budget for `POST /v1/cross-chain-swaps/{id}/deposit`, per consumer + client
 * address. An honest wallet reports a deposit once, and retries a few times if
 * 1Click is slow to see it; each call is an upstream request and a possible
 * webhook.
 */
export const CROSS_CHAIN_DEPOSIT_RATE_LIMIT = {
  name: 'cross-chain-swaps:deposit',
  limit: 20,
  windowMs: 60 * 1000,
};

/**
 * Rows the observer asks 1Click about per tick. Each is one `GET /v0/status`,
 * made one after another under the advisory lock; fifty at the default
 * NEAR_INTENTS_TIMEOUT_MS stays well inside the lock's transaction budget even
 * when 1Click is slow, and the least recently checked rows go first, so a
 * backlog is worked through over a few ticks rather than starved.
 */
export const CROSS_CHAIN_OBSERVER_BATCH = 50;

/**
 * How long past its deadline an EXPIRED swap is still polled. 1Click refunds a
 * deposit that arrives late, and the row has to follow it to REFUNDED — a day
 * covers a wallet that broadcast just before the deadline on a congested chain,
 * and bounds how long an address nobody paid costs a status call per tick.
 */
export const CROSS_CHAIN_RESCUE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The shortest deposit window a swap whose ORIGIN is Bitcoin gets, in seconds,
 * whatever `CROSS_CHAIN_SWAP_DEADLINE_SECONDS` says (it applies when larger).
 *
 * Bitcoin blocks come about every ten minutes, and 1Click credits a BTC
 * deposit only once it has confirmations. Under the 30-minute default, a
 * deposit sent promptly could still be seen after the deadline: refunded by
 * 1Click, and reported EXPIRED here first. Two hours covers three
 * confirmations with room for slow blocks. The row's `expiresAt` carries the
 * same deadline, and the observer's EXPIRED check reads only `expiresAt`, so
 * nothing marks a BTC deposit EXPIRED while it is still confirming.
 */
export const BITCOIN_ORIGIN_MIN_DEADLINE_SECONDS = 2 * 60 * 60;

/**
 * The deposit-window floor per origin chain, in seconds; 0 where the
 * configured deadline is enough on its own (every chain that confirms in
 * seconds or minutes).
 */
export const CROSS_CHAIN_MIN_DEADLINE_SECONDS: Record<SwapChain, number> = {
  stellar: 0,
  solana: 0,
  monad: 0,
  ethereum: 0,
  arbitrum: 0,
  base: 0,
  bitcoin: BITCOIN_ORIGIN_MIN_DEADLINE_SECONDS,
};

/**
 * The lock transaction's budget, as a multiple of the NEAR Intents timeout: one
 * tick is at most {@link CROSS_CHAIN_OBSERVER_BATCH} sequential status calls,
 * but 1Click answers in well under a second when healthy, so a tick that needs
 * more than this many timeouts' worth is one to abandon and retry.
 */
export const CROSS_CHAIN_LOCK_TIMEOUT_MULTIPLIER = 6;
