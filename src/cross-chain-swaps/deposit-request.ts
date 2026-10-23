import { bip21Uri } from '@/chains/bip21';
import {
  MONAD_CHAIN_IDS,
  SWAP_EVM_CHAIN_IDS,
  type SwapChain,
} from '@/chains/chains.constants';
import { parseUnits } from '@/chains/units';
import type { CrossChainAsset } from '@/cross-chain-swaps/cross-chain-assets';
import { CROSS_CHAIN_MIN_DEADLINE_SECONDS } from '@/cross-chain-swaps/cross-chain-swaps.constants';
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

type DepositLinkBuilder = (terms: DepositTerms) => string;

/**
 * An EIP-681 deposit on one EVM chain: the native coin as `value` in wei, an
 * ERC-20 as a `transfer` call. The chain id is what makes the wallet pay on
 * that chain and not on whichever one it has open.
 */
function evmDeposit(chainId: number): DepositLinkBuilder {
  return (terms) =>
    eip681Uri({
      chainId,
      recipient: terms.address,
      value: parseUnits(terms.amount, terms.asset.decimals),
      token: terms.asset.contract ?? undefined,
    });
}

/**
 * The wallet link that pays a deposit, in each chain's own standard — built
 * here, with this service's own builders, so the payer never needs anything
 * from NEAR Intents but the address:
 *
 *   - **Stellar**: SEP-7 `pay`, with the memo as a MEMO_TEXT — the type the
 *     deposits to 1Click's Stellar account carry (checked on Horizon);
 *   - **Solana**: a Solana Pay transfer request, `spl-token` for a token;
 *   - **Monad, Ethereum, Arbitrum, Base**: EIP-681 on chain 143, 1, 42161 or
 *     8453, `transfer` for an ERC-20 — mainnet only, as NEAR Intents is;
 *   - **Bitcoin**: BIP-21, the amount in decimal BTC.
 *
 * A `Record` over the swap-chain union, so a new chain does not compile until
 * it says how it is paid.
 */
export const DEPOSIT_LINK_BUILDERS: Record<SwapChain, DepositLinkBuilder> = {
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
  monad: evmDeposit(MONAD_CHAIN_IDS.public),
  ethereum: evmDeposit(SWAP_EVM_CHAIN_IDS.ethereum),
  arbitrum: evmDeposit(SWAP_EVM_CHAIN_IDS.arbitrum),
  base: evmDeposit(SWAP_EVM_CHAIN_IDS.base),
  bitcoin: (terms) =>
    bip21Uri({ address: terms.address, amount: terms.amount }),
};

export function depositLink(terms: DepositTerms): string {
  return DEPOSIT_LINK_BUILDERS[terms.asset.chain](terms);
}

/**
 * How long, in seconds, the deposit address of a swap from `origin` accepts
 * the deposit: the configured deadline, raised to the origin chain's floor in
 * {@link CROSS_CHAIN_MIN_DEADLINE_SECONDS} — two hours on Bitcoin, whose
 * deposits need confirmations about ten minutes apart.
 */
export function depositWindowSeconds(
  origin: SwapChain,
  configuredSeconds: number,
): number {
  return Math.max(configuredSeconds, CROSS_CHAIN_MIN_DEADLINE_SECONDS[origin]);
}
