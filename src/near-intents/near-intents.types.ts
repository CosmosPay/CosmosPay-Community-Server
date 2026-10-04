import type { NearIntentsStatus } from '@/near-intents/near-intents.constants';

/**
 * The parts of the 1Click API (https://1click.chaindefuser.com/docs/v0/openapi.yaml)
 * this service reads and writes. Only the fields something here uses are
 * declared; the rest of each payload is carried through untouched where it is
 * stored (the quote is kept whole for disputes).
 */

/** One entry of `GET /v0/tokens`. */
export interface NearIntentsToken {
  /** 1Click's id, e.g. `nep141:sol.omft.near`. */
  assetId: string;
  decimals: number;
  /** 1Click's chain name — see `NEAR_INTENTS_BLOCKCHAINS`. */
  blockchain: string;
  symbol: string;
  /** SPL mint, ERC-20 address or Stellar issuer; absent for a native coin. */
  contractAddress?: string;
  price?: number;
}

/** A fee paid out of `amountIn` to an account inside NEAR Intents. */
export interface NearIntentsAppFee {
  recipient: string;
  /** Basis points of `amountIn`. */
  fee: number;
}

/** `POST /v0/quote` body — the subset of options this service sets. */
export interface NearIntentsQuoteRequest {
  dry: boolean;
  swapType: 'EXACT_INPUT';
  depositMode: 'SIMPLE' | 'MEMO';
  slippageTolerance: number;
  originAsset: string;
  depositType: 'ORIGIN_CHAIN';
  destinationAsset: string;
  /** Base units of the origin asset, as an integer string. */
  amount: string;
  refundTo: string;
  refundType: 'ORIGIN_CHAIN';
  recipient: string;
  recipientType: 'DESTINATION_CHAIN';
  /** ISO timestamp after which a deposit is refunded. */
  deadline: string;
  referral?: string;
  appFees?: NearIntentsAppFee[];
}

/** `QuoteResponse.quote`. Deposit fields are absent on a dry quote. */
export interface NearIntentsQuote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd?: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd?: string;
  minAmountOut: string;
  deadline?: string;
  timeWhenInactive?: string;
  timeEstimate: number;
  refundFee?: string;
  withdrawFee?: string;
}

/** `POST /v0/quote` response. */
export interface NearIntentsQuoteResponse {
  correlationId: string;
  timestamp: string;
  /** 1Click's signature over the quote and its deposit address. */
  signature: string;
  quoteRequest: NearIntentsQuoteRequest;
  quote: NearIntentsQuote;
}

/** A transaction 1Click reports on either chain. */
export interface NearIntentsTransaction {
  hash: string;
  explorerUrl: string;
}

/** `GetExecutionStatusResponse.swapDetails`. */
export interface NearIntentsSwapDetails {
  amountIn?: string;
  amountInFormatted?: string;
  amountOut?: string;
  amountOutFormatted?: string;
  refundedAmount?: string;
  refundedAmountFormatted?: string;
  refundReason?: string;
  depositedAmountFormatted?: string;
  originChainTxHashes: NearIntentsTransaction[];
  destinationChainTxHashes: NearIntentsTransaction[];
}

/** `GET /v0/status` and `POST /v0/deposit/submit` response. */
export interface NearIntentsStatusResponse {
  correlationId: string;
  status: NearIntentsStatus;
  updatedAt: string;
  swapDetails?: NearIntentsSwapDetails;
}

/** `POST /v0/deposit/submit` body. */
export interface NearIntentsDepositSubmission {
  txHash: string;
  depositAddress: string;
  memo?: string;
}
