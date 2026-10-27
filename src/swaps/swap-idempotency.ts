import {
  type MerchantFeeTerms,
  sameMerchantFee,
} from '@/common/merchant-fee/merchant-fee';
import { STELLAR_DECIMALS } from '@/stellar/stellar.constants';
import { sameAmount } from '@/swaps/swap-math';

/**
 * The parts of a create-swap request that decide what the customer ends up
 * signing, in the form they are stored on the `Swap` row: assets resolved
 * (`native` / code + issuer), the destination defaulted to the source, the
 * slippage defaulted from config, the network taken from the API key.
 *
 * What is deliberately absent: the quote (`destEstimated`, `destMin`, `path`)
 * and the plan fee. Those are derived from Horizon and from the organization's
 * plan at build time, not chosen by the caller, so a retry a minute later would
 * legitimately differ on them and must still be recognised as the same request.
 * The merchant fee IS the caller's choice, and it pays a wallet the caller
 * names, so it is compared like the destination.
 */
export interface SwapRequestTerms {
  network: string;
  source: string;
  destination: string;
  sendAsset: string;
  sendAssetIssuer: string | null;
  sendAmount: string;
  destAsset: string;
  destAssetIssuer: string | null;
  slippageBps: number;
  memo: string | null;
  merchantFee: MerchantFeeTerms | null;
}

/** A stored swap as {@link swapMatchesRequest} reads it: its merchant fee is the stored record. */
export type StoredSwapTerms = Omit<SwapRequestTerms, 'merchantFee'> & {
  merchantFee: unknown;
};

/**
 * Whether a stored swap is the one this request would have built — the check
 * an `Idempotency-Key` replay must pass before it hands the stored XDR back.
 *
 * A key is scoped to the consumer, and under the shared public API key every
 * anonymous wallet is the same consumer. Returning the stored row for any
 * request that repeats the key let one caller pre-create a swap with
 * `source: VICTIM, destination: ATTACKER` under a guessable key, and hand that
 * envelope to the victim the next time their wallet sent the key. Matching on
 * every field that changes the signed transaction turns that into a 409.
 */
export function swapMatchesRequest(
  stored: StoredSwapTerms,
  request: SwapRequestTerms,
): boolean {
  return (
    stored.network === request.network &&
    stored.source === request.source &&
    stored.destination === request.destination &&
    stored.sendAsset === request.sendAsset &&
    stored.sendAssetIssuer === request.sendAssetIssuer &&
    stored.destAsset === request.destAsset &&
    stored.destAssetIssuer === request.destAssetIssuer &&
    stored.slippageBps === request.slippageBps &&
    stored.memo === request.memo &&
    sameAmount(stored.sendAmount, request.sendAmount) &&
    sameMerchantFee(stored.merchantFee, request.merchantFee, STELLAR_DECIMALS)
  );
}
