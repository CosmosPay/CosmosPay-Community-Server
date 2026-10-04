/**
 * `MONAD_DEPOSIT_TOKEN_FEES`: the relayer's fee for forwarding a deposit of
 * each ERC-20, in the token's own units — `{"0xToken…": "0.05"}`.
 *
 * A native-MON deposit's fee is quoted from the gas price when the intent is
 * created; a token's cannot be, because this service has no price for it. So
 * the operator states it per token. A token with no entry is forwarded with no
 * fee: the relayer pays the gas.
 *
 * Keys are stored lowercase, so the lookup does not depend on how the operator
 * cased the address. Throws on anything malformed — this is parsed at boot.
 */
export type EvmTokenFees = Readonly<Record<string, string>>;

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_RE = /^\d+(\.\d+)?$/;

export function parseEvmTokenFees(raw: string | undefined): EvmTokenFees {
  if (!raw || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('MONAD_DEPOSIT_TOKEN_FEES must be a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('MONAD_DEPOSIT_TOKEN_FEES must be a JSON object');
  }
  const out: Record<string, string> = {};
  for (const [token, fee] of Object.entries(parsed)) {
    if (!EVM_ADDRESS_RE.test(token)) {
      throw new Error(
        `MONAD_DEPOSIT_TOKEN_FEES: "${token}" is not an ERC-20 address (0x + 40 hex)`,
      );
    }
    if (typeof fee !== 'string' || !DECIMAL_RE.test(fee)) {
      throw new Error(
        `MONAD_DEPOSIT_TOKEN_FEES: the fee for ${token} must be a decimal string, e.g. "0.05"`,
      );
    }
    out[token.toLowerCase()] = fee;
  }
  return out;
}
