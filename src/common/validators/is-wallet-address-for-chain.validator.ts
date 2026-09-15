import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { StrKey } from '@stellar/stellar-sdk';

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Decodes a Solana-style base58 public key. Returns null when the string is not
 * valid base58 or does not decode to exactly 32 bytes.
 */
function decodeSolanaAddress(value: string): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  let num = 0n;
  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index < 0) {
      return null;
    }
    num = num * 58n + BigInt(index);
  }

  const bytes: number[] = [];
  while (num > 0n) {
    bytes.push(Number(num % 256n));
    num = num / 256n;
  }
  bytes.reverse();

  // Preserve leading zero bytes encoded as leading '1' characters in base58.
  for (const char of value) {
    if (char !== '1') {
      break;
    }
    bytes.unshift(0);
  }

  if (bytes.length !== 32) {
    return null;
  }
  return Uint8Array.from(bytes);
}

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
  // G... account, checksum verified by StrKey.
  stellar: {
    isValid: (address) => StrKey.isValidEd25519PublicKey(address),
    expected: 'a valid Stellar account address (G...)',
  },
  // base58 that decodes to a 32-byte public key.
  solana: {
    isValid: (address) => decodeSolanaAddress(address) !== null,
    expected: 'a valid Solana address (base58, 32 bytes)',
  },
  // 0x + 40 hex. Shape only — no EIP-55 checksum.
  evm: {
    isValid: (address) => EVM_ADDRESS_RE.test(address),
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
 * StrKey), Solana (base58 → 32 bytes), or EVM (0x + 40 hex).
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
