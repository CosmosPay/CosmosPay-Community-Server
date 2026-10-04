import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { CHAIN_ADDRESS_RULES } from '@/chains/chain-address';
import { DEFAULT_CHAIN, isChain } from '@/chains/chains.constants';

/**
 * The chain a request names, or {@link DEFAULT_CHAIN} when it names none — a
 * body written before Solana and Monad existed has no `chain`, and means
 * Stellar. `undefined` when the value is not a chain at all; `@IsIn` on the
 * `chain` field reports that, so this one does not repeat it.
 */
function chainOf(args: ValidationArguments) {
  const [chainProp] = args.constraints as [string];
  const value = (args.object as Record<string, unknown>)[chainProp];
  if (value === undefined || value === null) return DEFAULT_CHAIN;
  return isChain(value) ? value : undefined;
}

/**
 * Validates an address against the `chain` field on the same object, by that
 * chain's entry in {@link CHAIN_ADDRESS_RULES}: Stellar G… (StrKey checksum),
 * Solana base58 (32 bytes), Monad 0x + 40 hex. A missing chain is Stellar.
 */
export function IsChainAddress(
  chainProperty = 'chain',
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isChainAddress',
      target: object.constructor,
      propertyName,
      constraints: [chainProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const chain = chainOf(args);
          return (
            typeof value === 'string' &&
            chain !== undefined &&
            CHAIN_ADDRESS_RULES[chain].isValid(value)
          );
        },
        defaultMessage(args: ValidationArguments) {
          const chain = chainOf(args);
          if (!chain) {
            return `${args.property} must be a valid address for the given chain`;
          }
          const [chainProp] = args.constraints as [string];
          const named = (args.object as Record<string, unknown>)[chainProp];
          // A request that names no chain gets the message it always got.
          const suffix =
            named === undefined || named === null ? '' : ` for chain ${chain}`;
          return `${args.property} must be ${CHAIN_ADDRESS_RULES[chain].expected}${suffix}`;
        },
      },
    });
  };
}
