import {
  SWAP_CHAINS,
  SWAP_NATIVE_ASSET_CODES,
  SWAP_NATIVE_DECIMALS,
  type SwapChain,
} from '@/chains/chains.constants';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { NEAR_INTENTS_BLOCKCHAINS } from '@/near-intents/near-intents.constants';
import type { NearIntentsToken } from '@/near-intents/near-intents.types';

/** A token NEAR Intents can swap, on one of our swap chains. */
export interface CrossChainAsset {
  chain: SwapChain;
  /** The token's symbol as 1Click lists it (`XLM`, `USDC`, `ETH`, `BTC`). */
  symbol: string;
  /** 1Click's id for it — what a quote names. */
  assetId: string;
  decimals: number;
  /** SPL mint, ERC-20 address or Stellar issuer; null for the native coin. */
  contract: string | null;
}

/** The chain 1Click's `blockchain` names, when it is one of ours. */
const CHAIN_BY_BLOCKCHAIN = new Map<string, SwapChain>(
  SWAP_CHAINS.map((chain) => [NEAR_INTENTS_BLOCKCHAINS[chain], chain]),
);

/**
 * Whether a chain's contract ids are hex, and so one token in any case: an
 * ERC-20 address is `0xABC…` and `0xabc…` alike, while an SPL mint (base58)
 * and a Stellar issuer (StrKey) are case-sensitive. Bitcoin has no contracts.
 */
const CONTRACT_IGNORES_CASE: Record<SwapChain, boolean> = {
  stellar: false,
  solana: false,
  monad: true,
  ethereum: true,
  arbitrum: true,
  base: true,
  bitcoin: false,
};

/**
 * The tokens NEAR Intents lists on Stellar, Solana, Monad, Ethereum, Arbitrum,
 * Base and Bitcoin — the rest of its catalogue (NEAR, Tron, TON, …) is
 * reachable through 1Click but not through this service, which can validate
 * addresses and build deposit links only on the chains it knows.
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
 *   - the native coin by its ticker (`XLM`, `SOL`, `MON`, `ETH`, `BTC`) or
 *     `native`;
 *   - Stellar's `CODE:ISSUER`;
 *   - a contract — SPL mint, ERC-20 address (any case), Stellar issuer;
 *   - a symbol, when exactly one token on that chain carries it.
 *
 * The native coin is the listing with no contract, the chain's own ticker and
 * the chain's own decimals. 1Click lists Bitcoin twice — `BTC` and
 * `BTC(OMNI)`, both without a contract — and only the first is the one named
 * by `BTC`; the decimals guard a deposit link written in base units against a
 * listing that disagrees with the chain.
 *
 * A symbol two tokens share is refused rather than guessed: picking the wrong
 * `USDC` is a swap into a different asset.
 */
export function resolveCrossChainAsset(
  tokens: NearIntentsToken[],
  chain: SwapChain,
  requested: string,
): CrossChainAsset {
  const onChain = supportedAssets(tokens).filter((a) => a.chain === chain);
  const wanted = requested.trim();
  const lower = wanted.toLowerCase();
  const ticker = SWAP_NATIVE_ASSET_CODES[chain];

  if (lower === 'native' || lower === ticker.toLowerCase()) {
    const native = onChain.find(
      (a) =>
        a.contract === null &&
        a.symbol.toUpperCase() === ticker &&
        a.decimals === SWAP_NATIVE_DECIMALS[chain],
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
      contractKey(chain, a.contract) === contractKey(chain, wanted),
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

/**
 * Whether two listings are one asset on-chain. Two 1Click ids can name the
 * same coin — Bitcoin's `BTC` and `BTC(OMNI)` are both native BTC — and a
 * "swap" between them only pays fees to get back what was sent. Same chain
 * and both native, or the same contract (and, on Stellar, where one issuer
 * issues many codes, the same code).
 */
export function isSameAsset(a: CrossChainAsset, b: CrossChainAsset): boolean {
  if (a.assetId === b.assetId) return true;
  if (a.chain !== b.chain) return false;
  if (a.contract === null || b.contract === null) {
    return a.contract === b.contract;
  }
  if (a.chain === 'stellar' && a.symbol !== b.symbol) return false;
  return contractKey(a.chain, a.contract) === contractKey(b.chain, b.contract);
}

/** A contract id in the one spelling it compares in on `chain`. */
function contractKey(chain: SwapChain, contract: string): string {
  return CONTRACT_IGNORES_CASE[chain] ? contract.toLowerCase() : contract;
}

function unsupported(chain: SwapChain, asset: string): ApiError {
  return ApiError.badRequest(
    ApiErrorCode.AssetUnsupported,
    `NEAR Intents does not support asset "${asset}" on ${chain}. ` +
      'GET /v1/cross-chain-swaps/assets lists the ones it does.',
  );
}
