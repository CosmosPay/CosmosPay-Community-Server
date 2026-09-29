import type { Chain } from '@/chains/chains.constants';
import {
  EVM_TX_ID_RE,
  SOLANA_TX_ID_RE,
  TX_HASH_RE,
} from '@/payment-intents/payment-intents.constants';

/** What a transaction id looks like on one chain, and its one stored spelling. */
interface TxIdRule {
  re: RegExp;
  /** Completes "txHash must be … for a <chain> payment intent". */
  expected: string;
  normalize(id: string): string;
}

/**
 * Each chain's transaction id. The request DTOs accept any of the three shapes
 * (they do not know the intent's chain); the service checks the one that
 * applies and stores it in the spelling the chain's own API reports, so the
 * `(consumerId, txHash)` index sees one value per transaction.
 */
const TX_ID_RULES: Record<Chain, TxIdRule> = {
  // Hex, reported lowercase by Horizon.
  stellar: {
    re: TX_HASH_RE,
    expected: 'a Stellar transaction hash (64 hex characters)',
    normalize: (id) => id.toLowerCase(),
  },
  // Base58 is case-sensitive: stored exactly as given.
  solana: {
    re: SOLANA_TX_ID_RE,
    expected: 'a Solana transaction signature (base58)',
    normalize: (id) => id,
  },
  // Hex, reported lowercase by the node.
  monad: {
    re: EVM_TX_ID_RE,
    expected: 'a Monad transaction hash (0x + 64 hex characters)',
    normalize: (id) => id.toLowerCase(),
  },
};

export function isTxIdFor(chain: Chain, id: string): boolean {
  return TX_ID_RULES[chain].re.test(id);
}

export function normalizeTxId(chain: Chain, id: string): string {
  return TX_ID_RULES[chain].normalize(id);
}

export function expectedTxId(chain: Chain): string {
  return TX_ID_RULES[chain].expected;
}
