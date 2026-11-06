import type { ChainSwap } from '@generated/prisma/client';
import type { SwapPathHop } from '@/swaps/entities/swap.entity';

/** An asset as a venue resolved it. */
export interface VenueAsset {
  /** What the row stores and the API answers: `native`, or the mint / contract. */
  asset: string;
  decimals: number;
}

/** What pricing a same-chain swap needs, in base units. */
export interface VenueRequest {
  /** The wallet that signs; null for a quote, which names none. */
  source: string | null;
  send: VenueAsset;
  dest: VenueAsset;
  amount: bigint;
  slippageBps: number;
  feeBps: number;
  /** Where the commission is paid; null when `feeBps` is zero. */
  feeWallet: string | null;
  /**
   * The organization's merchant fee, in the SOURCE asset's base units, paid
   * out of the source wallet in the swap's own transaction; `amount` above is
   * what is routed. Null without one.
   */
  merchantFee?: { wallet: string; amount: bigint } | null;
}

/** A priced swap, in base units of the output asset. */
export interface VenueQuote {
  destEstimated: bigint;
  destMin: bigint;
  /** The commission, in the output asset. */
  feeAmount: bigint;
  path: SwapPathHop[];
  /** The aggregator's own answer, stored whole. */
  raw: unknown;
}

/** A priced swap plus what the wallet signs. */
export interface VenueBuild extends VenueQuote {
  transaction: Record<string, unknown>;
  approval: Record<string, unknown> | null;
}

/** Where a broadcast transaction stands on-chain. */
export type VenueSettlement = 'SUCCEEDED' | 'FAILED' | null;

/**
 * One chain's same-chain swap venue: an aggregator to price and build with,
 * and the chain's own RPC to check and broadcast what the wallet signed.
 * `ChainSwapsService` dispatches on the chain through a `Record` of these, so
 * a new chain is one more venue, not a branch in every method.
 */
export interface ChainSwapVenue {
  /** `sourceAssetCode` / `destAssetCode` as the request spelled it. */
  resolveAsset(asset: string): Promise<VenueAsset>;
  /**
   * Why this venue cannot pay a merchant fee on this deployment, or null when
   * it can. Asked before anything is priced.
   */
  merchantFeeUnsupported(): string | null;
  quote(request: VenueRequest): Promise<VenueQuote>;
  build(request: VenueRequest & { source: string }): Promise<VenueBuild>;
  /**
   * Checks that `signed` is the transaction handed out for `swap`, validly
   * signed by its source, and answers its id. Throws 400 `validation_failed`
   * otherwise. Reads nothing from the chain: it runs before the swap's status
   * is disclosed.
   */
  verify(swap: ChainSwap, signed: string): string;
  /**
   * For a wallet that sends the transaction itself and hands back only its
   * hash (an EVM browser wallet's `eth_sendTransaction`): reads the
   * transaction `txHash` names from the chain and checks it is the one built
   * for `swap`, sent by its source on the swap's chain, and answers its id.
   * Throws 400 `transaction_not_found` while the chain does not have it yet
   * (retryable) and 400 `validation_failed`, naming the field, when it is
   * another transaction. Answers nothing about the swap itself. Absent on a
   * venue whose wallets hand over signed bytes (Solana).
   */
  verifySent?(swap: ChainSwap, txHash: string): Promise<string>;
  /** Broadcasts a verified transaction through this service's own RPC. */
  broadcast(signed: string): Promise<void>;
  /** SUCCEEDED / FAILED once the chain has the transaction, else null. */
  settlement(txHash: string): Promise<VenueSettlement>;
}
