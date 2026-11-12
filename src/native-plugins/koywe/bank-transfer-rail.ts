import type { StellarNetwork } from '@/config/configuration';
import { LOCAL_MONEY_RE } from '@/native-plugins/koywe/bank-transfer';
import {
  BANK_TRANSFER_CURRENCY,
  KOYWE_PUBLIC_RAIL,
  type KoyweNetwork,
  type KoyweToken,
} from '@/native-plugins/koywe/koywe.constants';
import type {
  PaymentRequestTerms,
  PaymentRequestToken,
} from '@/payment-request-rails/payment-request-rails';

/**
 * Which payment requests a bank transfer can pay, as far as their terms go
 * (the owner's account is the service's to check): pure, so the rail table is
 * pinned by a spec.
 */

/** Where the provider converts a deposit to: its network and token. */
export interface ConversionTarget {
  network: KoyweNetwork;
  token: KoyweToken;
}

/** What the rail needs to know of the deployment. */
export interface RailSettings {
  /** The networks with a complete environment and the document pepper. */
  networks: readonly StellarNetwork[];
  minArs: number;
  maxArs: number;
  /** Where the sandbox converts every test request. */
  sandbox: ConversionTarget;
}

/** A pair the rail serves: the token the request stores, and where the provider converts to. */
interface RailPair {
  token: PaymentRequestToken;
  target: ConversionTarget;
}

/**
 * The pairs each network serves. Mainnet: the provider's own table of EVM
 * stablecoins, by contract (any case). The sandbox delivers no real crypto,
 * so a test request of any pair the P2P sandbox market lists (`listed`) is
 * converted to the configured sandbox network and token, which lets the
 * dashboard and the wallet test the flow with the requests they already make.
 */
const PAIRS: Record<
  StellarNetwork,
  (
    chainId: number,
    tokenAddress: string,
    listed: PaymentRequestToken | null,
    sandbox: ConversionTarget,
  ) => RailPair | null
> = {
  public: (chainId, tokenAddress) => {
    const pair = KOYWE_PUBLIC_RAIL[chainId]?.[tokenAddress.toLowerCase()];
    return pair
      ? {
          token: { symbol: pair.token, decimals: pair.decimals },
          target: { network: pair.network, token: pair.token },
        }
      : null;
  },
  testnet: (_chainId, _tokenAddress, listed, sandbox) =>
    listed ? { token: listed, target: sandbox } : null,
};

/**
 * The token a request on `terms` stores when a bank transfer can pay it, or
 * null: a served network, ARS, at most two decimals within the configured
 * bounds, and a pair the network serves.
 */
export function railTokenFor(
  terms: Omit<PaymentRequestTerms, 'ownerId'>,
  listed: PaymentRequestToken | null,
  settings: RailSettings,
): PaymentRequestToken | null {
  if (!settings.networks.includes(terms.network)) return null;
  if (terms.currency !== BANK_TRANSFER_CURRENCY) return null;
  if (!LOCAL_MONEY_RE.test(terms.amount)) return null;
  const amount = Number(terms.amount);
  if (amount < settings.minArs || amount > settings.maxArs) return null;
  return (
    PAIRS[terms.network](
      terms.chainId,
      terms.tokenAddress,
      listed,
      settings.sandbox,
    )?.token ?? null
  );
}

/** Where a request's deposit is converted to, or null for a pair the network does not serve. */
export function conversionTarget(
  network: StellarNetwork,
  chainId: number,
  tokenAddress: string,
  listed: PaymentRequestToken,
  sandbox: ConversionTarget,
): ConversionTarget | null {
  return PAIRS[network](chainId, tokenAddress, listed, sandbox)?.target ?? null;
}
