import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import {
  CROSS_CHAIN_NETWORKS,
  type CrossChainNetwork,
  isCrossChainNetworkId,
} from '@/cross-chain-swaps/cross-chain-networks';

/**
 * The network the field `chainProperty` names on the same object; undefined
 * when it names none this service reaches. `@IsIn` on that field reports the
 * bad network, so this validator does not report it a second time.
 */
function networkOf(args: ValidationArguments): CrossChainNetwork | undefined {
  const [chainProp] = args.constraints as [string];
  const value = (args.object as Record<string, unknown>)[chainProp];
  return isCrossChainNetworkId(value) ? CROSS_CHAIN_NETWORKS[value] : undefined;
}

/**
 * Validates an address against the cross-chain network named by
 * `chainProperty`, by that network's rule in `CROSS_CHAIN_NETWORKS`: Stellar
 * G… (StrKey checksum), Solana base58, 0x + 40 hex on EVM networks, the UTXO
 * coins' bech32 and base58 forms, and so on. The cross-chain counterpart of
 * `IsChainAddress`, which knows only the chains this service settles on.
 */
export function IsCrossChainAddress(
  chainProperty: string,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isCrossChainAddress',
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
            network.address.isValid(value)
          );
        },
        defaultMessage(args: ValidationArguments) {
          const network = networkOf(args);
          if (!network) {
            return `${args.property} must be a valid address for the given chain`;
          }
          return `${args.property} must be ${network.address.expected} for chain ${network.id}`;
        },
      },
    });
  };
}
