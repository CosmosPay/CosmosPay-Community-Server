import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import {
  type Chain,
  DEFAULT_CHAIN,
  isChain,
  MAX_TOKEN_DECIMALS,
} from '@/chains/chains.constants';
import { decimalPlaces } from '@/chains/units';

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/**
 * The most decimal places a request may write an amount with, per chain.
 * Stellar assets all have 7 (stroops). On Solana and Monad a token can be finer
 * than the chain's coin — an ERC-20 may declare 18 whatever the chain — so the
 * DTO admits the widest any token may have, and the service checks the asset's
 * own decimals once it has resolved it.
 */
const AMOUNT_MAX_PLACES: Record<Chain, number> = {
  stellar: 7,
  solana: MAX_TOKEN_DECIMALS,
  monad: MAX_TOKEN_DECIMALS,
};

function maxPlaces(args: ValidationArguments): number {
  const [chainProp] = args.constraints as [string];
  const value = (args.object as Record<string, unknown>)[chainProp];
  const chain = value === undefined || value === null ? DEFAULT_CHAIN : value;
  // A chain the `chain` field itself rejects: the widest bound, so this field
  // does not report a second error for the same mistake.
  return isChain(chain) ? AMOUNT_MAX_PLACES[chain] : MAX_TOKEN_DECIMALS;
}

/**
 * A positive decimal string with at most as many places as the object's chain
 * admits: 7 on Stellar (stroops), up to 18 on Solana and Monad, where the
 * asset's own decimals are checked once it is resolved. A missing chain is
 * Stellar, with the message Stellar amounts always got.
 */
export function IsDecimalAmount(
  chainProperty = 'chain',
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isDecimalAmount',
      target: object.constructor,
      propertyName,
      constraints: [chainProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          return (
            typeof value === 'string' &&
            DECIMAL_RE.test(value) &&
            decimalPlaces(value) <= maxPlaces(args)
          );
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a positive decimal with up to ${maxPlaces(args)} decimal places`;
        },
      },
    });
  };
}
