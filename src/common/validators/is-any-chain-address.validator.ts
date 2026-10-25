import { registerDecorator, ValidationOptions } from 'class-validator';
import {
  ANY_CHAIN_ADDRESS_EXPECTED,
  chainOfAddress,
} from '@/chains/chain-address';

/**
 * Validates an address on any chain the service settles, for a field that names no chain: the
 * shape decides which of `CHAIN_ADDRESS_RULES` applies (Stellar G... with its StrKey
 * checksum, Solana base58 of 32 bytes, Monad 0x + 40 hex in any case). It only validates;
 * the service stores the address in its chain's spelling (`normalizeAnyChainAddress`), so a
 * Monad address is kept EIP-55 checksummed, as payment intents record a Monad payer.
 */
export function IsAnyChainAddress(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isAnyChainAddress',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return typeof value === 'string' && chainOfAddress(value) !== null;
        },
        defaultMessage(args) {
          return `${args?.property ?? 'value'} must be ${ANY_CHAIN_ADDRESS_EXPECTED}`;
        },
      },
    });
  };
}
