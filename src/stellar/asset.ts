import { Asset } from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';

/** A caller-supplied asset resolved to an SDK `Asset` plus its stored form. */
export interface ResolvedAsset {
  /** `'native'` for lumens, otherwise the asset code as given. */
  code: string;
  /** `null` for lumens; required for anything else. */
  issuer: string | null;
  asset: Asset;
}

/**
 * No code (or `XLM`/`native`) → lumens; any other code needs an issuer.
 *
 * Extracted because swaps, liquidity pools, payment intents and products each
 * carried a copy. Four copies of the rule that decides which asset moves is
 * three too many — and they had already begun to differ in their error codes.
 */
export function resolveAsset(code?: string, issuer?: string): ResolvedAsset {
  const c = code?.trim();
  if (!c || c.toLowerCase() === 'xlm' || c.toLowerCase() === 'native') {
    return { code: 'native', issuer: null, asset: Asset.native() };
  }
  if (!issuer) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      `An issuer is required for non-native asset "${c}"`,
    );
  }
  return { code: c, issuer, asset: new Asset(c, issuer) };
}

/** Display label: lumens read as `XLM`, everything else as its code. */
export function assetLabel(asset: { code: string } | string): string {
  const code = typeof asset === 'string' ? asset : asset.code;
  return !code || code === 'native' ? 'XLM' : code;
}

/**
 * Canonical `native` / `CODE:ISSUER` key, matching how Horizon identifies the
 * reserves of a liquidity pool.
 */
export function assetKey(code: string, issuer?: string | null): string {
  return code === 'native' || !issuer ? 'native' : `${code}:${issuer}`;
}
