import { formatUnits, parseUnits } from '@/chains/units';
import type { CrossChainAsset } from '@/cross-chain-swaps/cross-chain-assets';

/**
 * What a payer sends for the merchant to receive `amountOut`, one for one
 * between two stablecoins: the same value written in the origin's decimals,
 * rounded UP (sending a fraction of a base unit less would pay the merchant
 * less). No commission and no slippage buffer in the sandbox: nothing is
 * priced on a test network.
 */
export function sandboxAmountIn(
  amountOut: string,
  destination: Pick<CrossChainAsset, 'decimals'>,
  origin: Pick<CrossChainAsset, 'decimals'>,
): string {
  const out = parseUnits(amountOut, destination.decimals);
  if (origin.decimals >= destination.decimals) {
    return formatUnits(
      out * 10n ** BigInt(origin.decimals - destination.decimals),
      origin.decimals,
    );
  }
  const scale = 10n ** BigInt(destination.decimals - origin.decimals);
  return formatUnits((out + scale - 1n) / scale, origin.decimals);
}

/** The id an asset of the sandbox carries (`sandbox:<network>:<contract>`). */
export function sandboxAssetId(network: string, contract: string): string {
  return `sandbox:${network}:${contract.toLowerCase()}`;
}
