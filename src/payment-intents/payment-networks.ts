import { CHAIN_ADDRESS_RULES } from '@/chains/chain-address';
import {
  type Chain,
  CHAIN_DISPLAY_NAMES,
  CHAINS,
  DEFAULT_CHAIN,
  isChain,
  NATIVE_ASSET_CODES,
} from '@/chains/chains.constants';
import {
  CROSS_CHAIN_NETWORKS,
  type CrossChainAddressRule,
  type CrossChainNetwork,
  isCrossChainNetworkId,
} from '@/cross-chain-swaps/cross-chain-networks';
import {
  CROSS_CHAIN_NETWORK_IDS,
  type CrossChainNetworkId,
} from '@/cross-chain-swaps/cross-chain-swaps.constants';
import { EVM_TX_ID_RE } from '@/payment-intents/payment-intents.constants';

/**
 * Every network a payment link settles on: every `Chain`, then every other
 * network the cross-chain route reaches. Derived from those two lists, never
 * kept by hand: a network NEAR Intents reaches and this service can validate
 * an address on (`CROSS_CHAIN_NETWORKS`) is a network links settle on, and so
 * is a chain this service settles natively that the route does not reach
 * (Arc, a {@link NativeOnlyChain}).
 *
 * Two ways to be paid hang off it:
 *
 *   - On a {@link Chain} (Stellar, Solana, Monad, Arc) the link is the chain's
 *     own wallet link (SEP-7, Solana Pay, EIP-681) and this service's observer
 *     finds the payment on that chain, as before.
 *   - On every other network ({@link DepositNetwork}) there is no observer of
 *     our own: the payer pays a deposit address NEAR Intents makes for that one
 *     payment (`payment_deposit`), from any network it reaches, and the link
 *     settles when NEAR Intents reports the merchant paid.
 *
 * A link on a chain the route reaches can ALSO be paid through a deposit
 * address (from another network), when it qualifies: see
 * `crossChainPaymentRefusal`. A link on Arc never can.
 */
export type PaymentNetwork = Chain | CrossChainNetworkId;
export const PAYMENT_NETWORKS: readonly PaymentNetwork[] = [
  ...CHAINS,
  ...CROSS_CHAIN_NETWORK_IDS.filter((id) => !isChain(id)),
];

/** The networks a link settles on only through a deposit address. */
export type DepositNetwork = Exclude<PaymentNetwork, Chain>;

/** The chains settled natively that the cross-chain route does not reach: Arc. */
export type NativeOnlyChain = Exclude<Chain, CrossChainNetworkId>;

export function isPaymentNetwork(value: unknown): value is PaymentNetwork {
  return isChain(value) || isCrossChainNetworkId(value);
}

/** What a payment link's network is named and validated by. */
export type PaymentNetworkRules = Pick<
  CrossChainNetwork,
  'name' | 'nativeSymbol' | 'address' | 'txId'
>;

/**
 * The rules of the chains the cross-chain route does not reach, beside the
 * route's own table. Arc's address rule is the one every other route applies
 * there (`CHAIN_ADDRESS_RULES`), its transaction ids are EVM hashes.
 */
const NATIVE_ONLY_RULES: Record<NativeOnlyChain, PaymentNetworkRules> = {
  arc: {
    name: CHAIN_DISPLAY_NAMES.arc,
    nativeSymbol: NATIVE_ASSET_CODES.arc,
    address: { ...CHAIN_ADDRESS_RULES.arc, caseInsensitive: true },
    txId: {
      isValid: (id) => EVM_TX_ID_RE.test(id),
      expected: 'an EVM transaction hash (0x + 64 hex)',
      normalize: (id) => id.toLowerCase(),
    },
  },
};

/**
 * Every payment network's name, coin and address and transaction-id rules. A
 * `Record` over {@link PaymentNetwork}: code that reads `intent.chain` reads
 * these, never `CROSS_CHAIN_NETWORKS` directly, which has no Arc.
 */
export const PAYMENT_NETWORK_RULES: Record<
  PaymentNetwork,
  PaymentNetworkRules
> = { ...CROSS_CHAIN_NETWORKS, ...NATIVE_ONLY_RULES };

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
 * What an account looks like on `network`: on Stellar, Solana, Monad and Arc
 * the same rule every other route applies there (`CHAIN_ADDRESS_RULES`, which
 * `CROSS_CHAIN_NETWORKS` reuses for the first three), elsewhere the network's
 * own.
 */
export function paymentAddressRule(
  network: PaymentNetwork,
): CrossChainAddressRule {
  return PAYMENT_NETWORK_RULES[network].address;
}

/** The network's display name (`Ethereum`, `Bitcoin`, `XRP Ledger`, `Arc`). */
export function paymentNetworkName(network: PaymentNetwork): string {
  return PAYMENT_NETWORK_RULES[network].name;
}

/** Whether the cross-chain route reaches `network` (every one but Arc). */
export function isRoutedNetwork(
  network: PaymentNetwork,
): network is CrossChainNetworkId {
  return isCrossChainNetworkId(network);
}
