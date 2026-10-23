import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import {
  CHAIN_ADDRESS_RULES,
  type ChainAddressRule,
} from '@/chains/chain-address';
import {
  type Chain,
  DEFAULT_CHAIN,
  isChain,
  isSwapChain,
  type SwapChain,
} from '@/chains/chains.constants';
import { SWAP_CHAIN_ADDRESS_RULES } from '@/chains/swap-chain-address';

/** A set of chains a field may name, and each one's address rule. */
interface AddressVocabulary<C extends string> {
  isChain(value: unknown): value is C;
  rules: Record<C, ChainAddressRule>;
  /** What a body that names no chain means. */
  defaultChain: C;
}

/** Payment intents, aliases, wallet sign-in, `/v1/swaps`: {@link Chain}. */
const CHAIN_ADDRESSES: AddressVocabulary<Chain> = {
  isChain,
  rules: CHAIN_ADDRESS_RULES,
  defaultChain: DEFAULT_CHAIN,
};

/** Cross-chain swaps only: {@link SwapChain}. */
const SWAP_CHAIN_ADDRESSES: AddressVocabulary<SwapChain> = {
  isChain: isSwapChain,
  rules: SWAP_CHAIN_ADDRESS_RULES,
  defaultChain: DEFAULT_CHAIN,
};

/**
 * The chain a request names, or the vocabulary's default when it names none —
 * a body written before Solana and Monad existed has no `chain`, and means
 * Stellar. `undefined` when the value is not a chain of the vocabulary at all;
 * `@IsIn` on the `chain` field reports that, so this one does not repeat it.
 */
function chainOf<C extends string>(
  vocabulary: AddressVocabulary<C>,
  args: ValidationArguments,
): C | undefined {
  const [chainProp] = args.constraints as [string];
  const value = (args.object as Record<string, unknown>)[chainProp];
  if (value === undefined || value === null) return vocabulary.defaultChain;
  return vocabulary.isChain(value) ? value : undefined;
}

function chainAddress<C extends string>(
  name: string,
  vocabulary: AddressVocabulary<C>,
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
          const chain = chainOf(vocabulary, args);
          return (
            typeof value === 'string' &&
            chain !== undefined &&
            vocabulary.rules[chain].isValid(value)
          );
        },
        defaultMessage(args: ValidationArguments) {
          const chain = chainOf(vocabulary, args);
          if (!chain) {
            return `${args.property} must be a valid address for the given chain`;
          }
          const [chainProp] = args.constraints as [string];
          const named = (args.object as Record<string, unknown>)[chainProp];
          // A request that names no chain gets the message it always got.
          const suffix =
            named === undefined || named === null ? '' : ` for chain ${chain}`;
          return `${args.property} must be ${vocabulary.rules[chain].expected}${suffix}`;
        },
      },
    });
  };
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
  return chainAddress(
    'isChainAddress',
    CHAIN_ADDRESSES,
    chainProperty,
    validationOptions,
  );
}

/**
 * {@link IsChainAddress} over the cross-chain swap vocabulary, by
 * {@link SWAP_CHAIN_ADDRESS_RULES}: the three above plus Ethereum, Arbitrum and
 * Base (0x + 40 hex) and Bitcoin mainnet (bech32/bech32m segwit or base58check,
 * checksum verified). A separate decorator so the cross-chain DTOs are the
 * only ones that accept those chains' addresses.
 */
export function IsSwapChainAddress(
  chainProperty: string,
  validationOptions?: ValidationOptions,
) {
  return chainAddress(
    'isSwapChainAddress',
    SWAP_CHAIN_ADDRESSES,
    chainProperty,
    validationOptions,
  );
}
