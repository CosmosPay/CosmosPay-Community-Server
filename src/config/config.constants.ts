/** Defaults applied when the corresponding environment variable is unset. */
import type { StellarNetwork } from '@/config/configuration';

export const DEFAULT_SWAP_FEE_BPS = 50;
export const DEFAULT_SWAP_SLIPPAGE_BPS = 50;
export const DEFAULT_SWAP_MAX_SLIPPAGE_BPS = 500;

/** Public Horizon endpoints, per network. */
export const DEFAULT_HORIZON: Record<StellarNetwork, string> = {
  public: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org',
};
