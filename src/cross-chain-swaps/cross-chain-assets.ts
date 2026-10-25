import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  CROSS_CHAIN_NETWORKS,
  networkByBlockchain,
} from '@/cross-chain-swaps/cross-chain-networks';
import type { CrossChainNetworkId } from '@/cross-chain-swaps/cross-chain-swaps.constants';
import type { NearIntentsToken } from '@/near-intents/near-intents.types';

/** A token NEAR Intents can swap, on one of the networks this service reaches. */
export interface CrossChainAsset {
  /** The network id requests name it by (`stellar`, `solana`, `eth`, `btc`). */
  chain: CrossChainNetworkId;
  /** The network's display name (`Stellar`, `Ethereum`, `Bitcoin`). */
  chainName: string;
  /** The token's symbol as 1Click lists it (`XLM`, `USDC`, `SOL`, `BTC`). */
  symbol: string;
  /** 1Click's id for it: what a quote names. */
  assetId: string;
  decimals: number;
  /**
   * The token's contract on its network (SPL mint, ERC-20 address, Stellar
   * issuer, Sui coin type, TON jetton master…); null for the native coin.
   */
  contract: string | null;
  /**
   * 1Click's reference price in USD, indicative only: it is cached for a few
   * minutes and nothing here prices from it. Every amount comes from a quote.
   * Null when 1Click lists none.
   */
  priceUsd: number | null;
}

/**
 * The tokens NEAR Intents lists on every network this service reaches
 * (`CROSS_CHAIN_NETWORKS`). A token on a blockchain with no entry there is
 * dropped: this service could not validate an address on it, nor say how a
 * deposit on it is paid.
 */
export function supportedAssets(tokens: NearIntentsToken[]): CrossChainAsset[] {
  const assets: CrossChainAsset[] = [];
  for (const token of tokens) {
    const network = networkByBlockchain(token.blockchain);
    if (!network) continue;
    assets.push({
      chain: network.id,
      chainName: network.name,
      symbol: token.symbol,
      assetId: token.assetId,
      decimals: token.decimals,
      contract: token.contractAddress || null,
      priceUsd:
        typeof token.price === 'number' && Number.isFinite(token.price)
          ? token.price
          : null,
    });
  }
  return assets;
}

/**
 * The native coin among a network's assets: the token with no contract. When
 * 1Click lists more than one (`BTC` and `BTC(OMNI)` on Bitcoin), the one
 * carrying the network's own ticker; none when that does not settle it.
 */
function nativeCoin(
  onChain: CrossChainAsset[],
  nativeSymbol: string,
): CrossChainAsset | undefined {
  const natives = onChain.filter((a) => a.contract === null);
  if (natives.length <= 1) return natives[0];
  return natives.find(
    (a) => a.symbol.toLowerCase() === nativeSymbol.toLowerCase(),
  );
}

/**
 * The asset a request names on `chain`. Accepted spellings, in the order they
 * are tried:
 *
 *   - `native`, the network's ticker (`XLM`, `ETH`, `BTC`) or the native
 *     token's own symbol, for the native coin;
 *   - Stellar's `CODE:ISSUER`;
 *   - a contract (SPL mint, ERC-20 address, Stellar issuer…), in any case on a
 *     network whose addresses are hex;
 *   - a symbol, when exactly one token on that network carries it.
 *
 * A symbol two tokens share is refused rather than guessed: picking the wrong
 * `USDC` is a swap into a different asset.
 */
export function resolveCrossChainAsset(
  tokens: NearIntentsToken[],
  chain: CrossChainNetworkId,
  requested: string,
): CrossChainAsset {
  const network = CROSS_CHAIN_NETWORKS[chain];
  const onChain = supportedAssets(tokens).filter((a) => a.chain === chain);
  const wanted = requested.trim();
  const lower = wanted.toLowerCase();

  const native = nativeCoin(onChain, network.nativeSymbol);
  if (lower === 'native') {
    if (native) return native;
    throw unsupported(chain, wanted);
  }
  if (
    native &&
    (lower === network.nativeSymbol.toLowerCase() ||
      lower === native.symbol.toLowerCase())
  ) {
    return native;
  }

  const [code, issuer] = wanted.split(':');
  if (chain === 'stellar' && issuer) {
    const match = onChain.find(
      (a) =>
        a.symbol.toLowerCase() === code.toLowerCase() && a.contract === issuer,
    );
    if (match) return match;
    throw unsupported(chain, wanted);
  }

  const byContract = onChain.find(
    (a) =>
      a.contract !== null &&
      (network.address.caseInsensitive
        ? a.contract.toLowerCase() === lower
        : a.contract === wanted),
  );
  if (byContract) return byContract;

  const bySymbol = onChain.filter((a) => a.symbol.toLowerCase() === lower);
  if (bySymbol.length === 1) return bySymbol[0];
  if (bySymbol.length > 1) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      `More than one ${wanted} is listed on ${chain}; name it by its contract ` +
        `(${bySymbol.map((a) => a.contract ?? 'native').join(', ')}).`,
    );
  }
  throw unsupported(chain, wanted);
}

function unsupported(chain: CrossChainNetworkId, asset: string): ApiError {
  return ApiError.badRequest(
    ApiErrorCode.AssetUnsupported,
    `NEAR Intents does not support asset "${asset}" on ${chain}. ` +
      'GET /v1/cross-chain-swaps/assets lists the ones it does.',
  );
}
