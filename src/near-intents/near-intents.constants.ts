import type { Chain } from '@/chains/chains.constants';

/**
 * What 1Click calls each of our chains in `TokenResponse.blockchain`. A
 * `Record` over the chain union, so a chain added to `CHAINS` does not compile
 * until it says whether — and as what — NEAR Intents reaches it. Checked
 * against `GET /v0/tokens` (2026-09-30): Stellar lists XLM and USDC, Solana SOL
 * and SPL tokens, Monad MON, USDC and USDT0. The other networks cross-chain
 * swaps reach are named by 1Click's own code in `CROSS_CHAIN_NETWORKS`.
 */
export const NEAR_INTENTS_BLOCKCHAINS: Record<Chain, string> = {
  stellar: 'stellar',
  solana: 'sol',
  monad: 'monad',
};

/**
 * How long the 1Click token list is reused. It changes when NEAR Intents lists
 * a token, which is rare. Its `price` field changes constantly, but nothing
 * here prices from it: every amount comes from a quote, and the asset list
 * passes it on only as an indicative `priceUsd`, so a price up to this old is
 * fine. Five minutes keeps a quote from costing two upstream calls without
 * pinning a delisting for long.
 */
export const NEAR_INTENTS_TOKENS_TTL_MS = 5 * 60 * 1000;

/**
 * How long a token list past its TTL is still served while a fresh one is fetched in the
 * background. The fetch takes most of a second (about 0.8 s measured), and a caller used to
 * pay it every five minutes: the dashboard's USD figures and the asset list now read the list
 * they have and never wait for a refresh. Past this age (1Click unreachable for an hour) the
 * list is no longer trusted and a caller waits for a fresh one, failing as it always did.
 */
export const NEAR_INTENTS_TOKENS_STALE_MS = 60 * 60 * 1000;

/**
 * `referral` on every quote: 1Click's distribution-channel label, so NEAR
 * Intents' own reporting attributes the volume to Cosmos Pay. Lowercase, as
 * their docs ask.
 */
export const NEAR_INTENTS_REFERRAL = 'cosmospay';

/** 1Click's execution statuses (`GetExecutionStatusResponse.status`). */
export const NEAR_INTENTS_STATUSES = [
  'PENDING_DEPOSIT',
  'KNOWN_DEPOSIT_TX',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED',
] as const;
export type NearIntentsStatus = (typeof NEAR_INTENTS_STATUSES)[number];
