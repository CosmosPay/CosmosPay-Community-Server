import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { CHAIN_ADDRESS_RULES, isEvmAddress } from '@/chains/chain-address';

/** What one chain accepts as a wallet address, and how its error names it. */
interface WalletAddressRule {
  isValid(address: string): boolean;
  /** Completes "`<property>` must be … for chain `<chain>`". */
  expected: string;
}

/**
 * Every chain the validator understands, keyed by the value of the `chain`
 * field. Both the check and the error message read this table, so a new chain
 * is one entry here rather than a `case` in one place and an `if` in another
 * that can fall out of step. A chain with no entry is rejected.
 */
export const WALLET_ADDRESS_RULES = {
  stellar: CHAIN_ADDRESS_RULES.stellar,
  solana: CHAIN_ADDRESS_RULES.solana,
  monad: CHAIN_ADDRESS_RULES.monad,
  // BlindPay's name for its EVM chain family. 0x + 40 hex, shape only — no
  // EIP-55 checksum.
  evm: {
    isValid: isEvmAddress,
    expected: 'a valid EVM address (0x + 40 hex)',
  },
} satisfies Record<string, WalletAddressRule>;

export type WalletAddressChain = keyof typeof WALLET_ADDRESS_RULES;

/**
 * The chain named on the object being validated, with its rule — or undefined
 * when the table has no entry for it. `Object.hasOwn` rather than a bare index:
 * the value comes from a request body, and `toString` or `__proto__` would
 * otherwise resolve to an inherited member instead of "no such chain".
 */
function chainRule(
  args: ValidationArguments,
): [WalletAddressChain, WalletAddressRule] | undefined {
  const [chainProp] = args.constraints as [string];
  const chain = (args.object as Record<string, unknown>)[chainProp];
  if (
    typeof chain !== 'string' ||
    !Object.hasOwn(WALLET_ADDRESS_RULES, chain)
  ) {
    return undefined;
  }
  const known = chain as WalletAddressChain;
  return [known, WALLET_ADDRESS_RULES[known]];
}

/**
 * Validates that a wallet address matches the `chain` field on the same object,
 * by that chain's entry in {@link WALLET_ADDRESS_RULES}: Stellar (G... via
 * StrKey), Solana (base58 → 32 bytes), or Monad / EVM (0x + 40 hex).
 */
export function IsWalletAddressForChain(
  chainProperty = 'chain',
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isWalletAddressForChain',
      target: object.constructor,
      propertyName,
      constraints: [chainProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const found = chainRule(args);
          return (
            typeof value === 'string' &&
            found !== undefined &&
            found[1].isValid(value)
          );
        },
        defaultMessage(args: ValidationArguments) {
          const found = chainRule(args);
          if (!found) {
            return `${args.property} must be a valid wallet address for the given chain`;
          }
          const [chain, rule] = found;
          return `${args.property} must be ${rule.expected} for chain ${chain}`;
        },
      },
    });
  };
}
