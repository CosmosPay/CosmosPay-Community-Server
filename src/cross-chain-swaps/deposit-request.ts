import { type Chain, MONAD_CHAIN_IDS } from '@/chains/chains.constants';
import { parseUnits } from '@/chains/units';
import type { CrossChainAsset } from '@/cross-chain-swaps/cross-chain-assets';
import {
  CARDANO_URI_SCHEME,
  TON_TRANSFER_URI_PREFIX,
} from '@/cross-chain-swaps/cross-chain-swaps.constants';
import { eip681Uri } from '@/evm/eip681';
import { solanaPayUri } from '@/solana/solana-pay';
import { resolveAsset } from '@/stellar/asset';
import { sep7PayUri } from '@/stellar/sep7';

/** What the payer must send, and where, to fund one cross-chain swap. */
export interface DepositTerms {
  /** 1Click's deposit address on the origin chain. */
  address: string;
  /** Required with the address on Stellar; null elsewhere unless 1Click issues one. */
  memo: string | null;
  /** Decimal, in the origin asset's own units. */
  amount: string;
  asset: CrossChainAsset;
}

/**
 * Builds the wallet link that pays a deposit, or answers null when the
 * deposit has no link: the payer then sends to the address (and memo) with any
 * wallet of that chain.
 */
export type DepositLinkBuilder = (terms: DepositTerms) => string | null;

/**
 * An EIP-681 link on `chainId`: `value` for the native coin, `transfer` for an
 * ERC-20, in base units. The chain id is what makes the wallet pay on the
 * right chain, so it comes only from a verified table.
 */
export function eip681DepositLink(
  chainId: number,
): (terms: DepositTerms) => string {
  return (terms) =>
    eip681Uri({
      chainId,
      recipient: terms.address,
      value: parseUnits(terms.amount, terms.asset.decimals),
      token: terms.asset.contract ?? undefined,
    });
}

/**
 * The wallet link that pays a deposit, in each chain's own standard, built
 * here, with this service's own builders, so the payer never needs anything
 * from NEAR Intents but the address:
 *
 *   - **Stellar**: SEP-7 `pay`, with the memo as a MEMO_TEXT, the type the
 *     deposits to 1Click's Stellar account carry (checked on Horizon);
 *   - **Solana**: a Solana Pay transfer request, `spl-token` for a token;
 *   - **Monad**: EIP-681 on chain 143, `transfer` for an ERC-20.
 *
 * A `Record` over the chain union, so a new chain does not compile until it
 * says how it is paid. The other networks cross-chain swaps reach take their
 * builder from `CROSS_CHAIN_NETWORKS`, which reuses these three.
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
  // Mainnet only: NEAR Intents has no Monad testnet.
  monad: eip681DepositLink(MONAD_CHAIN_IDS.public),
};

/**
 * A builder whose link has no field for a memo, guarded: when 1Click issued a
 * memo with the deposit, a link without it would pay an address that cannot
 * tell this deposit from another, so there is no link and the response's
 * `depositMemo` is what the payer must attach.
 */
export function memoless(build: DepositLinkBuilder): DepositLinkBuilder {
  return (terms) => (terms.memo ? null : build(terms));
}

/**
 * A BIP-21 style link, `<scheme>:<address>?amount=<coins>`, which Bitcoin and
 * the coins that copied it share (`litecoin:`, `dogecoin:`, `bitcoincash:`,
 * `dash:`, and Zcash's ZIP-321 `zcash:`). The amount is decimal, in the coin.
 * These chains carry only their own coin, so a token has no link. A deposit
 * address that already carries the scheme (a `bitcoincash:` cashaddr) is not
 * prefixed twice.
 */
export function bip21DepositLink(scheme: string): DepositLinkBuilder {
  const prefix = `${scheme}:`;
  return (terms) => {
    if (terms.asset.contract) return null;
    const address = terms.address.toLowerCase().startsWith(prefix)
      ? terms.address.slice(prefix.length)
      : terms.address;
    return `${prefix}${address}?amount=${terms.amount}`;
  };
}

/**
 * A TON transfer link, `ton://transfer/<address>?amount=<nanotons>`, for the
 * native coin only: a jetton transfer is a message to the payer's jetton
 * wallet, which no transfer link can name.
 */
export const tonDepositLink: DepositLinkBuilder = (terms) =>
  terms.asset.contract
    ? null
    : `${TON_TRANSFER_URI_PREFIX}${terms.address}` +
      `?amount=${parseUnits(terms.amount, terms.asset.decimals).toString()}`;

/**
 * A CIP-13 Cardano payment link, `web+cardano:<address>?amount=<ADA>`. CIP-13
 * writes the amount in decimal ADA (not lovelace) and has no field for a
 * native token, so only ADA gets a link.
 */
export const cardanoDepositLink: DepositLinkBuilder = (terms) =>
  terms.asset.contract
    ? null
    : `${CARDANO_URI_SCHEME}${terms.address}?amount=${terms.amount}`;
