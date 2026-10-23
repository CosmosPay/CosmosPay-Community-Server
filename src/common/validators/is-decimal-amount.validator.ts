import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import {
  type Chain,
  DEFAULT_CHAIN,
  isChain,
  isSwapChain,
  MAX_TOKEN_DECIMALS,
  SWAP_NATIVE_DECIMALS,
  type SwapChain,
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

/**
 * {@link AMOUNT_MAX_PLACES} over the cross-chain swap vocabulary. Ethereum,
 * Arbitrum and Base carry ERC-20s, so the widest bound, as on Monad; Bitcoin
 * carries one asset, BTC, whose smallest unit is the satoshi.
 */
const SWAP_AMOUNT_MAX_PLACES: Record<SwapChain, number> = {
  ...AMOUNT_MAX_PLACES,
  ethereum: MAX_TOKEN_DECIMALS,
  arbitrum: MAX_TOKEN_DECIMALS,
  base: MAX_TOKEN_DECIMALS,
  bitcoin: SWAP_NATIVE_DECIMALS.bitcoin,
};

/** A set of chains a field may name, and the places each one admits. */
interface AmountVocabulary<C extends string> {
  isChain(value: unknown): value is C;
  maxPlaces: Record<C, number>;
  /** What a body that names no chain means. */
  defaultChain: C;
}

const CHAIN_AMOUNTS: AmountVocabulary<Chain> = {
  isChain,
  maxPlaces: AMOUNT_MAX_PLACES,
  defaultChain: DEFAULT_CHAIN,
};

const SWAP_CHAIN_AMOUNTS: AmountVocabulary<SwapChain> = {
  isChain: isSwapChain,
  maxPlaces: SWAP_AMOUNT_MAX_PLACES,
  defaultChain: DEFAULT_CHAIN,
};

function maxPlaces<C extends string>(
  vocabulary: AmountVocabulary<C>,
  args: ValidationArguments,
): number {
  const [chainProp] = args.constraints as [string];
  const value = (args.object as Record<string, unknown>)[chainProp];
  const chain =
    value === undefined || value === null ? vocabulary.defaultChain : value;
  // A chain the `chain` field itself rejects: the widest bound, so this field
  // does not report a second error for the same mistake.
  return vocabulary.isChain(chain)
    ? vocabulary.maxPlaces[chain]
    : MAX_TOKEN_DECIMALS;
}

function decimalAmount<C extends string>(
  name: string,
  vocabulary: AmountVocabulary<C>,
  chainProperty: string,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name,
      target: object.constructor,
      propertyName,
      constraints: [chainProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          return (
            typeof value === 'string' &&
            DECIMAL_RE.test(value) &&
            decimalPlaces(value) <= maxPlaces(vocabulary, args)
          );
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a positive decimal with up to ${maxPlaces(vocabulary, args)} decimal places`;
        },
      },
    });
  };
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
  return decimalAmount(
    'isDecimalAmount',
    CHAIN_AMOUNTS,
    chainProperty,
    validationOptions,
  );
}

/**
 * {@link IsDecimalAmount} over the cross-chain swap vocabulary: up to 18
 * places on Ethereum, Arbitrum and Base, 8 on Bitcoin. Only the cross-chain
 * DTOs use it.
 */
export function IsSwapDecimalAmount(
  chainProperty: string,
  validationOptions?: ValidationOptions,
) {
  return decimalAmount(
    'isSwapDecimalAmount',
    SWAP_CHAIN_AMOUNTS,
    chainProperty,
    validationOptions,
  );
}
