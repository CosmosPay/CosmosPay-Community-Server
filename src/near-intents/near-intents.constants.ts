import type { Chain } from '@/chains/chains.constants';

/**
 * What 1Click calls each of our chains in `TokenResponse.blockchain`. A
 * `Record` over the chain union, so a chain added to `CHAINS` does not compile
 * until it says whether — and as what — NEAR Intents reaches it. Checked
 * against `GET /v0/tokens` (2026-09-30): Stellar lists XLM and USDC, Solana SOL
 * and SPL tokens, Monad MON, USDC and USDT0.
 */
export const NEAR_INTENTS_BLOCKCHAINS: Record<Chain, string> = {
  stellar: 'stellar',
  solana: 'sol',
  monad: 'monad',
};

/**
 * How long the 1Click token list is reused. It changes when NEAR Intents lists
 * a token, which is rare; its `price` field changes constantly, but nothing
 * here prices from it — every amount comes from a quote. Five minutes keeps a
 * quote from costing two upstream calls without pinning a delisting for long.
 */
export const NEAR_INTENTS_TOKENS_TTL_MS = 5 * 60 * 1000;

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
