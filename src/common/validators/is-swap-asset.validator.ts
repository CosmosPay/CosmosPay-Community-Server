import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { isEvmAddress, isSolanaAddress } from '@/chains/chain-address';
import {
  isSwapChain,
  NATIVE_ASSET_CODES,
  type SwapChain,
} from '@/chains/chains.constants';

/**
 * How each chain with a swap venue spells a swap asset, and how a refusal
 * describes it. Arc has no venue: the `chain` field refuses it first.
 */
const SWAP_ASSET_RULES: Record<
  SwapChain,
  { isValid(value: string): boolean; message(property: string): string }
> = {
  // Unchanged from before Solana and Monad: a Stellar asset code.
  stellar: {
    isValid: (value) => /^[a-zA-Z0-9]{1,12}$/.test(value),
    message: (property) => `${property} must be 1-12 alphanumeric characters`,
  },
  solana: {
    isValid: (value) => isNative('solana', value) || isSolanaAddress(value),
    message: (property) =>
      `${property} must be SOL, "native" or an SPL mint address for chain solana`,
  },
  monad: {
    isValid: (value) => isNative('monad', value) || isEvmAddress(value),
    message: (property) =>
      `${property} must be MON, "native" or an ERC-20 address for chain monad`,
  },
};

function isNative(chain: SwapChain, value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower === 'native' || lower === NATIVE_ASSET_CODES[chain].toLowerCase()
  );
}

/** What a swap request that names no chain means: Stellar (`DEFAULT_CHAIN`). */
const DEFAULT_SWAP_CHAIN: SwapChain = 'stellar';

function chainOf(args: ValidationArguments): SwapChain | undefined {
  const [chainProp] = args.constraints as [string];
  const value = (args.object as Record<string, unknown>)[chainProp];
  if (value === undefined || value === null) return DEFAULT_SWAP_CHAIN;
  return isSwapChain(value) ? value : undefined;
}

/**
 * A swap asset as the object's `chain` spells it: a Stellar asset code (the
 * issuer travels in its own field), or on Solana and Monad the native ticker,
 * `native`, or the token's mint / contract address. A missing chain is Stellar,
 * with the message Stellar swaps always got.
 */
export function IsSwapAsset(
  chainProperty = 'chain',
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isSwapAsset',
      target: object.constructor,
      propertyName,
      constraints: [chainProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const chain = chainOf(args);
          return (
            typeof value === 'string' &&
            // An unknown chain is reported by `@IsIn` on the chain field.
            (chain === undefined || SWAP_ASSET_RULES[chain].isValid(value))
          );
        },
        defaultMessage(args: ValidationArguments) {
          return SWAP_ASSET_RULES[chainOf(args) ?? DEFAULT_SWAP_CHAIN].message(
            args.property,
          );
        },
      },
    });
  };
}
