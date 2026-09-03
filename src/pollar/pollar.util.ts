import type { PollarWallet } from '@/pollar/pollar.types';
import { PollarWalletEntity } from '@/pollar/oauth/entities/pollar-session.entity';

/** A provider id, if it really is one. Anything else becomes null. */
export function asId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The address a Pollar wallet is reached at.
 *
 * Pollar reports it under `address` for every wallet type and additionally under
 * `publicKey` for classic G-addresses, so both are read and neither is assumed:
 * a smart wallet has no `publicKey`, and older payloads carry only that.
 */
export function walletAddress(wallet: PollarWallet | undefined): string | null {
  return wallet?.address ?? wallet?.publicKey ?? null;
}

/**
 * Projects a Pollar wallet onto the shape this API publishes.
 *
 * One mapper rather than one per call site: the login response, the token-verify
 * claims and the user-registration response all carry the same wallet object,
 * and three hand-rolled copies is three places for `address` to be spelled
 * differently.
 */
export function toPollarWalletEntity(wallet: PollarWallet): PollarWalletEntity {
  return {
    type: wallet.type,
    address: walletAddress(wallet),
    chain: wallet.chain,
    exists_on_stellar: wallet.existsOnStellar,
    funding_mode: wallet.fundingMode,
    network: wallet.network,
  };
}

/**
 * Narrows an undocumented `wallet` blob to a {@link PollarWallet}. Returns null
 * unless it is an object carrying an address, so a shape drift produces an
 * absent wallet rather than a half-built one.
 *
 * Needed only where Pollar publishes a result code but not the content shape —
 * the user-registration routes. Everywhere else the shape is in its OpenAPI.
 */
export function asPollarWallet(value: unknown): PollarWallet | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const address = asId(raw.address) ?? asId(raw.publicKey);
  if (!address) return null;
  return {
    type: (asId(raw.type) ?? 'internal') as PollarWallet['type'],
    address,
    chain: (asId(raw.chain) ?? undefined) as PollarWallet['chain'],
    ...(typeof raw.existsOnStellar === 'boolean'
      ? { existsOnStellar: raw.existsOnStellar }
      : {}),
    ...(asId(raw.network) ? { network: asId(raw.network)! } : {}),
  };
}
