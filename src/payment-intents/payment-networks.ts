import { type Chain, DEFAULT_CHAIN, isChain } from '@/chains/chains.constants';
import {
  CROSS_CHAIN_NETWORKS,
  type CrossChainAddressRule,
  isCrossChainNetworkId,
} from '@/cross-chain-swaps/cross-chain-networks';
import {
  CROSS_CHAIN_NETWORK_IDS,
  type CrossChainNetworkId,
} from '@/cross-chain-swaps/cross-chain-swaps.constants';

/**
 * Every network a payment link settles on. One list with cross-chain swaps on
 * purpose: a link can settle on any network NEAR Intents reaches and this
 * service can validate an address on (`CROSS_CHAIN_NETWORKS`), so a network
 * added there is a network links settle on, with no second table to keep.
 *
 * Two ways to be paid hang off it:
 *
 *   - On a {@link Chain} (Stellar, Solana, Monad) the link is the chain's own
 *     wallet link (SEP-7, Solana Pay, EIP-681) and this service's observer
 *     finds the payment on that chain, as before.
 *   - On every other network ({@link DepositNetwork}) there is no observer of
 *     our own: the payer pays a deposit address NEAR Intents makes for that one
 *     payment (`payment_deposit`), from any network it reaches, and the link
 *     settles when NEAR Intents reports the merchant paid.
 *
 * A link on a chain can ALSO be paid through a deposit address (from another
 * network), when it qualifies: see `crossChainPaymentRefusal`.
 */
export const PAYMENT_NETWORKS = CROSS_CHAIN_NETWORK_IDS;
export type PaymentNetwork = CrossChainNetworkId;

/** The networks a link settles on only through a deposit address. */
export type DepositNetwork = Exclude<PaymentNetwork, Chain>;

export function isPaymentNetwork(value: unknown): value is PaymentNetwork {
  return isCrossChainNetworkId(value);
}

/** Whether a link on `network` is paid only through deposit addresses. */
export function isDepositNetwork(value: unknown): value is DepositNetwork {
  return isCrossChainNetworkId(value) && !isChain(value);
}

/**
 * A stored intent's network. Rows from before the column existed are Stellar
 * by its default; a value this build does not know is a data error, and a 500
 * beats reading it by another network's rules.
 */
export function paymentNetworkOf(
  value: string | null | undefined,
): PaymentNetwork {
  if (value === undefined || value === null) return DEFAULT_CHAIN;
  if (!isPaymentNetwork(value)) {
    throw new Error(`Payment intent on unknown chain "${value}"`);
  }
  return value;
}

/**
 * What an account looks like on `network`: on Stellar, Solana and Monad the
 * same rule every other route applies there (`CHAIN_ADDRESS_RULES`, which
 * `CROSS_CHAIN_NETWORKS` reuses for them), elsewhere the network's own.
 */
export function paymentAddressRule(
  network: PaymentNetwork,
): CrossChainAddressRule {
  return CROSS_CHAIN_NETWORKS[network].address;
}

/** The network's display name (`Ethereum`, `Bitcoin`, `XRP Ledger`). */
export function paymentNetworkName(network: PaymentNetwork): string {
  return CROSS_CHAIN_NETWORKS[network].name;
}
