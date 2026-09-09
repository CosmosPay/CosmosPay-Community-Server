import { Injectable } from '@nestjs/common';
import {
  ASSET_REGISTRY,
  ASSET_REGISTRY_VERSION,
  type RegistryAsset,
  type RegistryNetwork,
} from '@/assets/assets.constants';

/**
 * Serves the asset registry.
 *
 * Deliberately not backed by the database. The registry is a decision about who
 * this platform vouches for, reviewed in a pull request and deployed with the
 * code; a table would let it change without review, which is the whole risk the
 * list exists to manage. It also means the endpoint has no failure mode worth
 * catching — no query, no connection, nothing to time out.
 */
@Injectable()
export class AssetsService {
  /**
   * The catalog for one network, verified entries first.
   *
   * The order is part of the contract, not a nicety: a client that renders the
   * list as it arrives puts the vetted issuers above the unvetted ones without
   * needing to know what `verified` means. Within each group the registry's own
   * order is kept, which puts XLM and the major stablecoins at the top.
   */
  list(network: RegistryNetwork, verifiedOnly = false): RegistryAsset[] {
    const all = ASSET_REGISTRY[network] ?? [];
    const rows = verifiedOnly ? all.filter((a) => a.verified) : all;
    return [...rows].sort((a, b) => Number(b.verified) - Number(a.verified));
  }

  /** The registry version a client compares against its bundled copy. */
  get version(): number {
    return ASSET_REGISTRY_VERSION;
  }
}
