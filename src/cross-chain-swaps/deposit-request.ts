import { type Chain, MONAD_CHAIN_IDS } from '@/chains/chains.constants';
import { parseUnits } from '@/chains/units';
import type { CrossChainAsset } from '@/cross-chain-swaps/cross-chain-assets';
import { eip681Uri } from '@/evm/eip681';
import { solanaPayUri } from '@/solana/solana-pay';
import { resolveAsset } from '@/stellar/asset';
import { sep7PayUri } from '@/stellar/sep7';

/** What the payer must send, and where, to fund one cross-chain swap. */
export interface DepositTerms {
  /** 1Click's deposit address on the origin chain. */
  address: string;
  /** Required with the address on Stellar; null elsewhere. */
  memo: string | null;
  /** Decimal, in the origin asset's own units. */
  amount: string;
  asset: CrossChainAsset;
}

/**
 * The wallet link that pays a deposit, in each chain's own standard — built
 * here, with this service's own builders, so the payer never needs anything
 * from NEAR Intents but the address:
 *
 *   - **Stellar**: SEP-7 `pay`, with the memo as a MEMO_TEXT — the type the
 *     deposits to 1Click's Stellar account carry (checked on Horizon);
 *   - **Solana**: a Solana Pay transfer request, `spl-token` for a token;
 *   - **Monad**: EIP-681 on chain 143, `transfer` for an ERC-20.
 *
 * A `Record` over the chain union, so a new chain does not compile until it
 * says how it is paid.
 */
export const DEPOSIT_LINK_BUILDERS: Record<
  Chain,
  (terms: DepositTerms) => string
> = {
  stellar: (terms) => {
    if (!terms.memo) {
      // 1Click issues Stellar deposits in MEMO mode only; a memo-less one
      // would be credited to nobody.
      throw new Error('A Stellar deposit needs its memo');
    }
    return sep7PayUri({
      destination: terms.address,
      amount: terms.amount,
      asset: terms.asset.contract
        ? resolveAsset(terms.asset.symbol, terms.asset.contract)
        : resolveAsset(),
      memo: terms.memo,
      memoType: 'MEMO_TEXT',
    });
  },
  solana: (terms) =>
    solanaPayUri({
      recipient: terms.address,
      amount: terms.amount,
      splToken: terms.asset.contract ?? undefined,
    }),
  monad: (terms) =>
    eip681Uri({
      // Mainnet only: NEAR Intents has no Monad testnet.
      chainId: MONAD_CHAIN_IDS.public,
      recipient: terms.address,
      value: parseUnits(terms.amount, terms.asset.decimals),
      token: terms.asset.contract ?? undefined,
    }),
};

export function depositLink(terms: DepositTerms): string {
  return DEPOSIT_LINK_BUILDERS[terms.asset.chain](terms);
}
