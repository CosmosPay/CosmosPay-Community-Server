import type {
  CrossChainSwapStatus,
  SwapStatus,
  Usdt0TransferStatus,
} from '@generated/prisma/client';

/** Tuning knobs for the read-only analytics aggregates. */

/** One day in milliseconds — the bucket width for time-series rollups. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The periods the dashboard's chart groups payments, swaps, liquidity operations and webhook
 * deliveries by, and how many buckets of each it shows (`GET /v1/summary/series`): 30 days,
 * 12 weeks, 12 months, 5 years.
 */
export const SERIES_PERIODS = {
  day: 30,
  week: 12,
  month: 12,
  year: 5,
} as const;
export type SeriesPeriod = keyof typeof SERIES_PERIODS;

/**
 * Where a row stands in the series: settled, given up on (nothing more will happen unless a
 * late observation heals it), or still moving. Every status of every model counted in
 * `GET /v1/summary/series` maps to exactly one of these through a table below, never through a
 * guess at the status name, so a new status does not compile until someone decides what it is.
 */
export const SERIES_OUTCOMES = ['succeeded', 'failed', 'inProgress'] as const;
export type SeriesOutcome = (typeof SERIES_OUTCOMES)[number];

/**
 * Stellar DEX swaps (`swap`). PENDING is built and unsigned, SUBMITTED is on its way to the
 * ledger: both still move. FAILED is a rejection; EXPIRED is a transaction whose time bounds
 * elapsed, so it can no longer land, and it is a failure for the same reason an expired payment
 * intent is one in the payments half. (The observer's rescue sweep may still heal a false FAILED
 * or EXPIRED to SUCCEEDED; the next read follows the row.)
 */
export const SWAP_OUTCOMES: Record<SwapStatus, SeriesOutcome> = {
  PENDING: 'inProgress',
  SUBMITTED: 'inProgress',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  EXPIRED: 'failed',
};

/**
 * Solana and Monad swaps through Jupiter and Kuru Flow (`chain_swap`). Same lifecycle as the
 * Stellar swaps: PENDING (the aggregator's transaction, unsigned) and SUBMITTED (broadcast,
 * awaiting the chain) still move. EXPIRED is a transaction not submitted before its deadline,
 * or one the chain did not confirm within its landing window: a failure like FAILED (the
 * observer's rescue window may still settle it). Kept apart from `SWAP_OUTCOMES` because the
 * table is apart: the two share an enum, not a guarantee that a status means the same on both.
 */
export const CHAIN_SWAP_OUTCOMES: Record<SwapStatus, SeriesOutcome> = {
  PENDING: 'inProgress',
  SUBMITTED: 'inProgress',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  EXPIRED: 'failed',
};

/**
 * Cross-chain swaps through NEAR Intents (`cross_chain_swap`). The four open statuses the
 * observer still polls (`CROSS_CHAIN_OPEN_STATUSES`) are in progress. SUCCEEDED paid the
 * recipient. REFUNDED returned the input to the payer, so the swap did not happen: a failure,
 * as are FAILED and EXPIRED (nothing deposited by the deadline; a late deposit moves it on to
 * REFUNDED, still a failure).
 */
export const CROSS_CHAIN_SWAP_OUTCOMES: Record<
  CrossChainSwapStatus,
  SeriesOutcome
> = {
  AWAITING_DEPOSIT: 'inProgress',
  DEPOSIT_DETECTED: 'inProgress',
  INCOMPLETE_DEPOSIT: 'inProgress',
  PROCESSING: 'inProgress',
  SUCCEEDED: 'succeeded',
  REFUNDED: 'failed',
  FAILED: 'failed',
  EXPIRED: 'failed',
};

/**
 * USDT0 sent from Stellar through LayerZero's OFT (`usdt0_transfer`), counted as a swap of kind
 * `usdt0`. PENDING is built and unsigned, SUBMITTED is on the Stellar ledger while LayerZero
 * delivers it (about 27 minutes): both still move. DELIVERED credited the recipient on the
 * destination network. FAILED is a Stellar transaction that failed or a message LayerZero gave
 * up on; EXPIRED never reached the ledger before its time bounds closed: both failures.
 */
export const USDT0_TRANSFER_OUTCOMES: Record<
  Usdt0TransferStatus,
  SeriesOutcome
> = {
  PENDING: 'inProgress',
  SUBMITTED: 'inProgress',
  DELIVERED: 'succeeded',
  FAILED: 'failed',
  EXPIRED: 'failed',
};

/**
 * Stellar AMM deposits and withdrawals (`liquidity_pool_operation`), which reuse `SwapStatus`
 * with the swap's lifecycle (`lp-operation-transitions.ts`): PENDING and SUBMITTED still move,
 * SUCCEEDED liquidated on-chain, FAILED and EXPIRED did not.
 */
export const LIQUIDITY_OPERATION_OUTCOMES: Record<SwapStatus, SeriesOutcome> = {
  PENDING: 'inProgress',
  SUBMITTED: 'inProgress',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  EXPIRED: 'failed',
};

/**
 * The kinds the swaps half of the series splits its totals into, one per table: `dex` is the
 * Stellar DEX (`swap`), `chain` a same-chain swap on Solana or Monad (`chain_swap`),
 * `crossChain` a swap between networks through NEAR Intents (`cross_chain_swap`), and `usdt0`
 * USDT0 sent from Stellar to an EVM network through LayerZero (`usdt0_transfer`).
 */
export const SERIES_SWAP_KINDS = [
  'dex',
  'chain',
  'crossChain',
  'usdt0',
] as const;
export type SeriesSwapKind = (typeof SERIES_SWAP_KINDS)[number];
