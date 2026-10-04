import {
  CHAINS,
  type Chain,
  NATIVE_ASSET_CODES,
} from '@/chains/chains.constants';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { NEAR_INTENTS_BLOCKCHAINS } from '@/near-intents/near-intents.constants';
import type { NearIntentsToken } from '@/near-intents/near-intents.types';

/** A token NEAR Intents can swap, on one of our chains. */
export interface CrossChainAsset {
  chain: Chain;
  /** The token's symbol as 1Click lists it (`XLM`, `USDC`, `SOL`, `MON`). */
  symbol: string;
  /** 1Click's id for it — what a quote names. */
  assetId: string;
  decimals: number;
  /** SPL mint, ERC-20 address or Stellar issuer; null for the native coin. */
  contract: string | null;
}

/** The chain 1Click's `blockchain` names, when it is one of ours. */
const CHAIN_BY_BLOCKCHAIN = new Map<string, Chain>(
  CHAINS.map((chain) => [NEAR_INTENTS_BLOCKCHAINS[chain], chain]),
);

/**
 * The tokens NEAR Intents lists on Stellar, Solana and Monad — the rest of its
 * catalogue (Bitcoin, Ethereum, …) is reachable through 1Click but not through
 * this service, which can validate addresses and build payment links only on
 * the chains it knows.
 */
export function supportedAssets(tokens: NearIntentsToken[]): CrossChainAsset[] {
  const assets: CrossChainAsset[] = [];
  for (const token of tokens) {
    const chain = CHAIN_BY_BLOCKCHAIN.get(token.blockchain);
    if (!chain) continue;
    assets.push({
      chain,
      symbol: token.symbol,
      assetId: token.assetId,
      decimals: token.decimals,
      contract: token.contractAddress || null,
    });
  }
  return assets;
}

/**
 * The asset a request names on `chain`. Accepted spellings, in the order they
 * are tried:
 *
 *   - the native coin by its ticker (`XLM`, `SOL`, `MON`) or `native`;
 *   - Stellar's `CODE:ISSUER`;
 *   - a contract — SPL mint, ERC-20 address (any case), Stellar issuer;
 *   - a symbol, when exactly one token on that chain carries it.
 *
 * A symbol two tokens share is refused rather than guessed: picking the wrong
 * `USDC` is a swap into a different asset.
 */
export function resolveCrossChainAsset(
  tokens: NearIntentsToken[],
  chain: Chain,
  requested: string,
): CrossChainAsset {
  const onChain = supportedAssets(tokens).filter((a) => a.chain === chain);
  const wanted = requested.trim();
  const lower = wanted.toLowerCase();

  if (lower === 'native' || lower === NATIVE_ASSET_CODES[chain].toLowerCase()) {
    const native = onChain.find(
      (a) =>
        a.contract === null &&
        a.symbol.toUpperCase() === NATIVE_ASSET_CODES[chain],
    );
    if (native) return native;
    throw unsupported(chain, wanted);
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
      (chain === 'monad'
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

function unsupported(chain: Chain, asset: string): ApiError {
  return ApiError.badRequest(
    ApiErrorCode.AssetUnsupported,
    `NEAR Intents does not support asset "${asset}" on ${chain}. ` +
      'GET /v1/cross-chain-swaps/assets lists the ones it does.',
  );
}
