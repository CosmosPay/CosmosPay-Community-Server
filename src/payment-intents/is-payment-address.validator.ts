import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { CHAIN_ADDRESS_RULES } from '@/chains/chain-address';
import { DEFAULT_CHAIN, isChain } from '@/chains/chains.constants';
import {
  isPaymentNetwork,
  type PaymentNetwork,
  paymentAddressRule,
} from '@/payment-intents/payment-networks';
import { PAYMENT_TOKEN_ID_RE } from '@/payment-intents/payment-intents.constants';

/**
 * The network a payment request names, or Stellar when it names none (a body
 * written before the other networks existed means Stellar). `undefined` when
 * the value is no network at all: `@IsIn` on the `chain` field reports that,
 * so these validators do not repeat it.
 */
function networkOf(args: ValidationArguments): PaymentNetwork | undefined {
  const [chainProp] = args.constraints as [string];
  const value = (args.object as Record<string, unknown>)[chainProp];
  if (value === undefined || value === null) return DEFAULT_CHAIN;
  return isPaymentNetwork(value) ? value : undefined;
}

/** " for chain <id>" when the request named one; nothing when it relied on the default. */
function chainSuffix(args: ValidationArguments, network: PaymentNetwork) {
  const [chainProp] = args.constraints as [string];
  const named = (args.object as Record<string, unknown>)[chainProp];
  return named === undefined || named === null ? '' : ` for chain ${network}`;
}

/**
 * An account on the payment's network (the `chain` field on the same object):
 * on Stellar, Solana and Monad exactly what `IsChainAddress` accepts there,
 * with the same messages, and on every other network its rule in
 * `CROSS_CHAIN_NETWORKS` (0x + 40 hex on EVM networks, the UTXO coins'
 * bech32 and base58 forms, `r…` on the XRP Ledger, and so on).
 */
export function IsPaymentAddress(
  chainProperty = 'chain',
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isPaymentAddress',
      target: object.constructor,
      propertyName,
      constraints: [chainProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const network = networkOf(args);
          return (
            typeof value === 'string' &&
            network !== undefined &&
            paymentAddressRule(network).isValid(value)
          );
        },
        defaultMessage(args: ValidationArguments) {
          const network = networkOf(args);
          if (!network) {
            return `${args.property} must be a valid address for the given chain`;
          }
          return `${args.property} must be ${paymentAddressRule(network).expected}${chainSuffix(args, network)}`;
        },
      },
    });
  };
}

/**
 * The token a payment is in, on its network: on Stellar the issuer account,
 * on Solana the SPL mint, on Monad the ERC-20 contract (each an address of the
 * chain, as before). On every other network a token is named by whatever the
 * cross-chain route lists as its contract, which is not always an address (a
 * Sui coin type is `0x…::usdc::USDC`, a NEAR token an account id), so the shape
 * is only bounded here and the service accepts nothing the route does not
 * list.
 */
export function IsPaymentAssetIssuer(
  chainProperty = 'chain',
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isPaymentAssetIssuer',
      target: object.constructor,
      propertyName,
      constraints: [chainProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const network = networkOf(args);
          if (typeof value !== 'string' || network === undefined) return false;
          return isChain(network)
            ? CHAIN_ADDRESS_RULES[network].isValid(value)
            : PAYMENT_TOKEN_ID_RE.test(value);
        },
        defaultMessage(args: ValidationArguments) {
          const network = networkOf(args);
          if (!network) {
            return `${args.property} must be a valid address for the given chain`;
          }
          if (isChain(network)) {
            return `${args.property} must be ${CHAIN_ADDRESS_RULES[network].expected}${chainSuffix(args, network)}`;
          }
          return `${args.property} must be the token's contract as the cross-chain route lists it for chain ${network}`;
        },
      },
    });
  };
}
