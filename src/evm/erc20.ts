import { ERC20_APPROVE_SELECTOR } from '@/evm/evm.constants';

/** A 32-byte ABI word: an address or an unsigned integer, left-padded. */
function word(value: string | bigint): string {
  const hex =
    typeof value === 'bigint'
      ? value.toString(16)
      : value.toLowerCase().replace(/^0x/, '');
  return hex.padStart(64, '0');
}

/**
 * `approve(spender, amount)` calldata — what a wallet sends before an ERC-20
 * sale so the swap router may pull exactly the amount being sold. Exactly, not
 * unlimited: an infinite approval outlives the swap and is a standing risk if
 * the router is ever compromised.
 */
export function approveCalldata(spender: string, amount: bigint): string {
  return ERC20_APPROVE_SELECTOR + word(spender) + word(amount);
}
