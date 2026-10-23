import type { SwapChain } from '@/chains/chains.constants';

/**
 * What 1Click calls each of our swap chains in `TokenResponse.blockchain`. A
 * `Record` over the swap-chain union, so a chain added to `SWAP_CHAINS` does
 * not compile until it says as what NEAR Intents reaches it. Checked against
 * `GET /v0/tokens` (2026-09-30 for the first three, 2026-10-23 for the rest):
 * Stellar lists XLM and USDC, Solana SOL and SPL tokens, Monad MON, USDC and
 * USDT0; Ethereum, Arbitrum and Base ETH and ERC-20s; Bitcoin BTC — twice, as
 * `BTC` and `BTC(OMNI)`, two routes to the one coin.
 */
export const NEAR_INTENTS_BLOCKCHAINS: Record<SwapChain, string> = {
  stellar: 'stellar',
  solana: 'sol',
  monad: 'monad',
  ethereum: 'eth',
  arbitrum: 'arb',
  base: 'base',
  bitcoin: 'btc',
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
