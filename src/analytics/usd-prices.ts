import {
  isChain,
  MAX_TOKEN_DECIMALS,
  NATIVE_ASSET_CODES,
} from '@/chains/chains.constants';
import {
  supportedAssets,
  type CrossChainAsset,
} from '@/cross-chain-swaps/cross-chain-assets';
import { CROSS_CHAIN_NETWORKS } from '@/cross-chain-swaps/cross-chain-networks';
import { formatNumericAmount } from '@/common/money';
import type { NearIntentsToken } from '@/near-intents/near-intents.types';

/**
 * The dashboard's settled volume in USD. Settled payments are in whatever asset they were paid
 * in, so adding their amounts together means nothing (1 XLM + 1.5 USDC is not 2.5 of anything);
 * each (chain, asset) is valued at NEAR Intents' current reference price instead (1Click's
 * `GET /v0/tokens`, cached for a few minutes). The value is indicative: today's price, not the
 * one on the day each payment settled, and never used to move money.
 *
 * Pure, so the matching is tested without NEAR Intents.
 */

/** A settled asset as the analytics queries group it. */
export interface SettledAsset {
  chain: string;
  /** What `ASSET_LABEL_SQL` reports: the chain's coin (XLM, SOL, MON) for `native`, else the code. */
  asset: string;
  /** The Stellar issuer, the SPL mint or the ERC-20 contract; null for the chain's coin. */
  issuer: string | null;
}

/** A settled asset with its exact summed amount and how many payments it covers. */
export interface SettledRow extends SettledAsset {
  /** `SUM("amount"::numeric)` as the driver returns it; null when nothing was summed. */
  amount: unknown;
  count: number;
}

/** USD per unit of an asset, or null when NEAR Intents lists no price for it. */
export type UsdPricer = (asset: SettledAsset) => number | null;

/**
 * Prices the assets of one network tier (`public` or `testnet`) from 1Click's token list:
 *
 *   - the chain's coin (no issuer) at the native token's price;
 *   - on mainnet, a token by its contract (on Stellar the issuer and the code), and nothing
 *     else: a token named USDC from an issuer 1Click does not list is not USDC;
 *   - on a test network, where no issuer is ever listed, a token at the price of the one token
 *     of that symbol on the chain's mainnet (test USDC at USDC's price);
 *   - a token with no issuer recorded, by its symbol when exactly one token carries it.
 *
 * A symbol two listed tokens share prices nothing rather than a guess, and a price that is
 * missing, zero or not finite counts as none.
 */
export function usdPricer(
  tokens: NearIntentsToken[],
  network: string,
): UsdPricer {
  const byChain = new Map<string, CrossChainAsset[]>();
  for (const a of supportedAssets(tokens)) {
    if (a.priceUsd === null || !(a.priceUsd > 0)) continue;
    const list = byChain.get(a.chain) ?? [];
    list.push(a);
    byChain.set(a.chain, list);
  }

  return ({ chain, asset, issuer }) => {
    if (!isChain(chain)) return null;
    const listed = byChain.get(chain) ?? [];
    const code = asset.trim().toLowerCase();
    const coin = NATIVE_ASSET_CODES[chain].toLowerCase();

    if (!issuer) {
      if (code === '' || code === 'native' || code === coin) {
        return nativeCoin(listed, coin)?.priceUsd ?? null;
      }
      return bySymbol(listed, code);
    }
    if (network !== 'public') return bySymbol(listed, code);

    const caseInsensitive = CROSS_CHAIN_NETWORKS[chain].address.caseInsensitive;
    const sameContract = (contract: string) =>
      caseInsensitive
        ? contract.toLowerCase() === issuer.toLowerCase()
        : contract === issuer;
    const match = listed.find(
      (a) =>
        a.contract !== null &&
        sameContract(a.contract) &&
        // A Stellar issuer issues any number of codes: the code has to match too.
        (chain !== 'stellar' || a.symbol.toLowerCase() === code),
    );
    return match?.priceUsd ?? null;
  };
}

/**
 * The chain's coin among its listed tokens: the one with no contract, or, when 1Click lists
 * more than one, the one carrying the coin's ticker.
 */
function nativeCoin(
  listed: CrossChainAsset[],
  coin: string,
): CrossChainAsset | undefined {
  const natives = listed.filter((a) => a.contract === null);
  if (natives.length <= 1) return natives[0];
  return natives.find((a) => a.symbol.toLowerCase() === coin);
}

/** The price of the one token (never the coin) carrying `code`; null when none or several do. */
function bySymbol(listed: CrossChainAsset[], code: string): number | null {
  const matches = listed.filter(
    (a) => a.contract !== null && a.symbol.toLowerCase() === code,
  );
  return matches.length === 1 ? matches[0].priceUsd : null;
}

/** What a set of settled rows is worth: its USD value and the payments no price covers. */
export interface UsdValue {
  /**
   * The priced rows' value in USD. Null only when there was something to value and no price
   * list to value it with (`pricer` null): NEAR Intents could not be read.
   */
  usd: number | null;
  /** Settled payments whose asset has no price (all of them when there is no price list). */
  unpriced: number;
  /** Settled payments that were priced. */
  priced: number;
}

/** Values settled rows with `pricer` (null when NEAR Intents' list could not be read). */
export function valueRows(
  rows: readonly SettledRow[],
  pricer: UsdPricer | null,
): UsdValue {
  let usd = 0;
  let unpriced = 0;
  let priced = 0;
  for (const row of rows) {
    const price = pricer ? pricer(row) : null;
    if (price === null) {
      unpriced += row.count;
      continue;
    }
    priced += row.count;
    // A float is enough for an indicative figure shown to the cent; the exact amount stays
    // in `volume`.
    usd += Number(formatNumericAmount(row.amount, MAX_TOKEN_DECIMALS)) * price;
  }
  // Nothing settled is worth nothing, price list or not.
  if (!pricer) return { usd: unpriced > 0 ? null : 0, unpriced, priced };
  return { usd, unpriced, priced };
}

/** A USD figure as the API reports it: two decimals, or null. */
export function formatUsd(usd: number | null): string | null {
  return usd === null ? null : usd.toFixed(2);
}
