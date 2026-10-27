/** Constants for cross-chain swaps settled by NEAR Intents. */

/**
 * Budget for `POST /v1/cross-chain-swaps/quote`, per consumer + client address.
 *
 * A quote persists nothing here, but it is a solver auction at 1Click, and every
 * call this service makes counts against the one partner key the whole
 * deployment shares. The route takes the shared public key, so a wallet polling
 * a price in a loop would spend that budget for every anonymous caller at once.
 * Sixty a minute is a price refreshed once a second — as fast as anyone reads one.
 */
export const CROSS_CHAIN_QUOTE_RATE_LIMIT = {
  name: 'cross-chain-swaps:quote',
  limit: 60,
  windowMs: 60 * 1000,
};

/**
 * Budget for `POST /v1/cross-chain-swaps`, per consumer + client address.
 *
 * Each create is a live 1Click quote that derives a deposit address, a row this
 * service polls until the swap settles or the deadline plus
 * {@link CROSS_CHAIN_RESCUE_WINDOW_MS} passes, and a webhook. Twenty a minute is
 * several honest swaps started at once from one address; a builder that never
 * deposits is bounded the same way.
 */
export const CROSS_CHAIN_CREATE_RATE_LIMIT = {
  name: 'cross-chain-swaps:create',
  limit: 20,
  windowMs: 60 * 1000,
};

/**
 * Budget for `POST /v1/cross-chain-swaps/{id}/deposit`, per consumer + client
 * address. An honest wallet reports a deposit once, and retries a few times if
 * 1Click is slow to see it; each call is an upstream request and a possible
 * webhook.
 */
export const CROSS_CHAIN_DEPOSIT_RATE_LIMIT = {
  name: 'cross-chain-swaps:deposit',
  limit: 20,
  windowMs: 60 * 1000,
};

/**
 * Rows the observer asks 1Click about per tick. Each is one `GET /v0/status`,
 * made one after another under the advisory lock; fifty at the default
 * NEAR_INTENTS_TIMEOUT_MS stays well inside the lock's transaction budget even
 * when 1Click is slow, and the least recently checked rows go first, so a
 * backlog is worked through over a few ticks rather than starved.
 */
export const CROSS_CHAIN_OBSERVER_BATCH = 50;

/**
 * How long past its deadline an EXPIRED swap is still polled. 1Click refunds a
 * deposit that arrives late, and the row has to follow it to REFUNDED — a day
 * covers a wallet that broadcast just before the deadline on a congested chain,
 * and bounds how long an address nobody paid costs a status call per tick.
 */
export const CROSS_CHAIN_RESCUE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The lock transaction's budget, as a multiple of the NEAR Intents timeout: one
 * tick is at most {@link CROSS_CHAIN_OBSERVER_BATCH} sequential status calls,
 * but 1Click answers in well under a second when healthy, so a tick that needs
 * more than this many timeouts' worth is one to abandon and retry.
 */
export const CROSS_CHAIN_LOCK_TIMEOUT_MULTIPLIER = 6;

// ── Networks ────────────────────────────────────────────────────────────────

/**
 * Every network cross-chain swaps reach, by the id requests and stored rows
 * name it with. Stellar, Solana and Monad keep the names the rest of this
 * service gives them (`Chain`), so rows written before the others existed stay
 * valid; every other network is 1Click's own `blockchain` code. The order is
 * the one the OpenAPI enum lists: the three chains this service settles on,
 * then by family (EVM, UTXO, the rest).
 *
 * 1Click also lists `qtc` and `adi`. They are left out on purpose: their
 * address formats could not be confirmed, and an address this service cannot
 * validate is a refund it cannot promise. Their tokens are dropped from the
 * asset list like any other unknown blockchain's.
 */
export const CROSS_CHAIN_NETWORK_IDS = [
  'stellar',
  'solana',
  'monad',
  'eth',
  'base',
  'arb',
  'op',
  'bsc',
  'pol',
  'avax',
  'gnosis',
  'bera',
  'scroll',
  'xlayer',
  'abs',
  'plasma',
  'hood',
  'hypercore',
  'btc',
  'ltc',
  'doge',
  'bch',
  'dash',
  'zec',
  'xrp',
  'tron',
  'ton',
  'near',
  'sui',
  'aptos',
  'movement',
  'starknet',
  'cardano',
  'aleo',
  'fogo',
] as const;
export type CrossChainNetworkId = (typeof CROSS_CHAIN_NETWORK_IDS)[number];

/**
 * EIP-155 chain ids of the EVM networks whose deposits get an EIP-681 link (Monad's
 * is `MONAD_CHAIN_IDS.public`). The id is what makes a wallet pay on that chain
 * rather than on whichever one it has open, so a wrong one sends the deposit to
 * an address on another chain: each was checked on 2026-10-25 against
 * chainlist's registry (chainid.network/chains.json) AND against `eth_chainId`
 * on the chain's own public RPC, and both agreed.
 *
 * Robinhood Chain (`hood`) and Hyperliquid (`hypercore`) take EVM-shaped
 * addresses but have no entry, so their deposits carry no link and are paid to
 * the address with any wallet of that chain. HyperCore is Hyperliquid's own L1,
 * not an EVM chain an EIP-681 link can pay on. Robinhood Chain is left out by
 * decision for now; its id (4663) checks out on both sources above, so adding
 * it is one entry here.
 */
export const CROSS_CHAIN_EVM_CHAIN_IDS = {
  eth: 1,
  base: 8453,
  arb: 42161,
  op: 10,
  bsc: 56,
  pol: 137,
  avax: 43114,
  gnosis: 100,
  bera: 80094,
  scroll: 534352,
  xlayer: 196,
  abs: 2741,
  plasma: 9745,
} as const satisfies Partial<Record<CrossChainNetworkId, number>>;

/** The prefix of a TON transfer link (`ton://transfer/<address>?amount=<nanotons>`). */
export const TON_TRANSFER_URI_PREFIX = 'ton://transfer/';

/** The scheme of a CIP-13 Cardano payment link; its `amount` is decimal ADA. */
export const CARDANO_URI_SCHEME = 'web+cardano:';

// Address and transaction-id shapes of the networks Stellar, Solana and Monad
// do not already cover (`@/chains/chain-address`, `payment-intents.constants`).
// Shape only: 1Click reads the chain itself and refuses an address it cannot
// pay, so these exist to turn a typo or a wrong-chain paste into a 400 with the
// expected format, before a quote is spent on it. Bech32 parts are matched in
// lowercase; mixed case is refused by the caller, as BIP-173 requires.

/** Bitcoin SegWit / Taproot (`bc1q…`, `bc1p…`). */
export const BTC_BECH32_RE = /^bc1[02-9ac-hj-np-z]{39,59}$/;
/** Bitcoin legacy P2PKH (`1…`) and P2SH (`3…`), base58. */
export const BTC_BASE58_RE = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/;
/** Litecoin SegWit (`ltc1…`). */
export const LTC_BECH32_RE = /^ltc1[02-9ac-hj-np-z]{39,59}$/;
/** Litecoin legacy (`L…`, `M…`, and the old P2SH `3…`). */
export const LTC_BASE58_RE = /^[LM3][1-9A-HJ-NP-Za-km-z]{26,33}$/;
/** Dogecoin P2PKH (`D…`) and P2SH (`A…`, `9…`). */
export const DOGE_BASE58_RE = /^[DA9][1-9A-HJ-NP-Za-km-z]{25,33}$/;
/** Bitcoin Cash cashaddr, prefix optional: a 20-byte (42) or 32-byte (61) payload. */
export const BCH_CASHADDR_RE =
  /^(?:bitcoincash:)?[qp](?:[02-9ac-hj-np-z]{41}|[02-9ac-hj-np-z]{60})$/;
/** Dash P2PKH (`X…`) and P2SH (`7…`). */
export const DASH_BASE58_RE = /^[X7][1-9A-HJ-NP-Za-km-z]{33}$/;
/** Zcash transparent P2PKH (`t1…`) and P2SH (`t3…`). */
export const ZEC_TRANSPARENT_RE = /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/;
/** Zcash unified address (`u1…`, bech32m; the shortest, one receiver, is 106). */
export const ZEC_UNIFIED_RE = /^u1[02-9ac-hj-np-z]{100,1000}$/;
/** XRP Ledger classic address (`r…`, base58 in Ripple's alphabet: same characters). */
export const XRP_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
/** Tron base58check address (`T…`, 34 characters). */
export const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
/** TON user-friendly address: 36 bytes as 48 base64url (or base64) characters. */
export const TON_FRIENDLY_ADDRESS_RE =
  /^[A-Za-z0-9_-]{48}$|^[A-Za-z0-9+/]{48}$/;
/** TON raw address: workchain (0, or -1 for the masterchain) and a 32-byte hex id. */
export const TON_RAW_ADDRESS_RE = /^(?:0|-1):[0-9a-fA-F]{64}$/;
/**
 * A NEAR account id (nomicon "Account ID" rules): 2 to 64 characters,
 * lowercase, parts of `[a-z0-9]` joined by single `-` or `_`, separated by
 * dots. A 64-hex implicit account and a `0x…` one fit the same rule.
 */
export const NEAR_ACCOUNT_ID_RE =
  /^(?=.{2,64}$)(?:(?:[a-z\d]+[-_])*[a-z\d]+\.)*(?:[a-z\d]+[-_])*[a-z\d]+$/;
/** Sui address: 0x + 32 bytes. */
export const SUI_ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/;
/** Aptos / Movement / Starknet: 0x + up to 32 bytes (short forms like `0x1` exist). */
export const SHORT_HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/;
/** Cardano Shelley address (`addr1…`, bech32; enterprise 58, base 103 characters). */
export const CARDANO_ADDRESS_RE = /^addr1[02-9ac-hj-np-z]{50,200}$/;
/** Aleo address (`aleo1` + 58 bech32m characters). */
export const ALEO_ADDRESS_RE = /^aleo1[02-9ac-hj-np-z]{58}$/;

/** A 32-byte digest in base58: NEAR transaction hashes, Sui transaction digests. */
export const BASE58_DIGEST_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** A TON transaction hash: 64 hex, or 32 bytes in base64 / base64url. */
export const TON_TX_ID_RE = /^[0-9a-fA-F]{64}$|^[A-Za-z0-9+/_-]{43}=?$/;
/** A Starknet transaction hash: a felt, 0x + up to 64 hex. */
export const STARKNET_TX_ID_RE = /^0x[0-9a-fA-F]{1,64}$/;
/** An Aleo transaction id (`at1` + 58 bech32m characters). */
export const ALEO_TX_ID_RE = /^at1[02-9ac-hj-np-z]{58}$/;

/**
 * 1Click's tag on a token it is retiring (`USDT0(DEPRECATED)`,
 * `XPL_(DEPRECATED)` on Plasma). Such a token is neither listed nor accepted:
 * a swap into it delivers an asset on its way out.
 */
export const DEPRECATED_TOKEN_RE = /_?\(DEPRECATED\)$/i;
