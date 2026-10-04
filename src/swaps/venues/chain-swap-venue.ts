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
  quote(request: VenueRequest): Promise<VenueQuote>;
  build(request: VenueRequest & { source: string }): Promise<VenueBuild>;
  /**
   * Checks that `signed` is the transaction handed out for `swap`, validly
   * signed by its source, and answers its id. Throws 400 `validation_failed`
   * otherwise. Reads nothing from the chain: it runs before the swap's status
   * is disclosed.
   */
  verify(swap: ChainSwap, signed: string): string;
  /** Broadcasts a verified transaction through this service's own RPC. */
  broadcast(signed: string): Promise<void>;
  /** SUCCEEDED / FAILED once the chain has the transaction, else null. */
  settlement(txHash: string): Promise<VenueSettlement>;
}
