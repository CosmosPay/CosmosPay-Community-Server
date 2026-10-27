import {
  CHAIN_ADDRESS_RULES,
  isEvmAddress,
  isSolanaAddress,
  toChecksumAddress,
} from '@/chains/chain-address';
import {
  type Chain,
  MONAD_CHAIN_IDS,
  NATIVE_ASSET_CODES,
} from '@/chains/chains.constants';
import {
  ALEO_ADDRESS_RE,
  ALEO_TX_ID_RE,
  BASE58_DIGEST_RE,
  BCH_CASHADDR_RE,
  BTC_BASE58_RE,
  BTC_BECH32_RE,
  CARDANO_ADDRESS_RE,
  CROSS_CHAIN_EVM_CHAIN_IDS,
  CROSS_CHAIN_NETWORK_IDS,
  type CrossChainNetworkId,
  DASH_BASE58_RE,
  DOGE_BASE58_RE,
  LTC_BASE58_RE,
  LTC_BECH32_RE,
  NEAR_ACCOUNT_ID_RE,
  SHORT_HEX_ADDRESS_RE,
  STARKNET_TX_ID_RE,
  SUI_ADDRESS_RE,
  TON_FRIENDLY_ADDRESS_RE,
  TON_RAW_ADDRESS_RE,
  TON_TX_ID_RE,
  TRON_ADDRESS_RE,
  XRP_ADDRESS_RE,
  ZEC_TRANSPARENT_RE,
  ZEC_UNIFIED_RE,
} from '@/cross-chain-swaps/cross-chain-swaps.constants';
import {
  bip21DepositLink,
  cardanoDepositLink,
  DEPOSIT_LINK_BUILDERS,
  type DepositLinkBuilder,
  type DepositTerms,
  eip681DepositLink,
  memoless,
  tonDepositLink,
} from '@/cross-chain-swaps/deposit-request';
import { NEAR_INTENTS_BLOCKCHAINS } from '@/near-intents/near-intents.constants';
import {
  EVM_TX_ID_RE,
  SOLANA_TX_ID_RE,
  TX_HASH_RE,
} from '@/payment-intents/payment-intents.constants';

/** What one network accepts as an account address, and how an error names it. */
export interface CrossChainAddressRule {
  isValid(address: string): boolean;
  /**
   * Whether two spellings that differ only in case are one address (hex
   * encodings). Contracts on such a network are compared case-insensitively.
   */
  caseInsensitive: boolean;
  /** Completes "`<property>` must be … for chain `<id>`". */
  expected: string;
  /** The one spelling the service stores, compares and sends to 1Click. */
  normalize(address: string): string;
}

/** What one network accepts as a transaction id for `POST /{id}/deposit`. */
export interface CrossChainTxIdRule {
  isValid(txId: string): boolean;
  expected: string;
  /** Hex is stored lowercase; base58 and base64 are case-sensitive and kept. */
  normalize(txId: string): string;
}

/** A network cross-chain swaps reach through NEAR Intents. */
export interface CrossChainNetwork {
  /** What requests and stored rows call it. */
  id: CrossChainNetworkId;
  /** What 1Click calls it (`TokenResponse.blockchain`). */
  blockchain: string;
  /** Display name. */
  name: string;
  /**
   * The native coin's ticker. `native`, this ticker and the native token's own
   * symbol all name the coin, and it picks the coin when 1Click lists more
   * than one token without a contract on the network (`BTC` and `BTC(OMNI)`).
   */
  nativeSymbol: string;
  address: CrossChainAddressRule;
  txId: CrossChainTxIdRule;
  /** The EIP-155 chain id its deposit link names; null when it has none. */
  evmChainId: number | null;
  /** Null when the chain has no wallet-link standard this service builds. */
  depositLink: DepositLinkBuilder | null;
}

const identity = (value: string): string => value;
const lowercase = (value: string): string => value.toLowerCase();

/**
 * A bech32 / cashaddr string in one case, lowercased; null when its case is
 * mixed, which BIP-173 forbids (the checksum covers one case only).
 */
function singleCase(value: string): string | null {
  const lower = value.toLowerCase();
  return value === lower || value === value.toUpperCase() ? lower : null;
}

/** Hex transaction ids: a pattern, stored lowercase. */
function hexTxId(re: RegExp, expected: string): CrossChainTxIdRule {
  return { isValid: (id) => re.test(id), expected, normalize: lowercase };
}

/** Base58 / bech32 transaction ids: a pattern, kept as written. */
function exactTxId(re: RegExp, expected: string): CrossChainTxIdRule {
  return { isValid: (id) => re.test(id), expected, normalize: identity };
}

const EVM_TX_ID = hexTxId(
  EVM_TX_ID_RE,
  'an EVM transaction hash (0x + 64 hex)',
);
const HEX_TX_ID = hexTxId(TX_HASH_RE, 'a transaction hash (64 hex)');

/**
 * A UTXO coin's addresses: SegWit-style bech32 (lowercased, mixed case
 * refused) and the legacy base58 forms, kept as written.
 */
function utxoAddress(
  bech32: RegExp | null,
  base58: RegExp,
  expected: string,
): CrossChainAddressRule {
  const isBech32 = (address: string) => {
    const lower = singleCase(address);
    return bech32 !== null && lower !== null && bech32.test(lower);
  };
  return {
    isValid: (address) => base58.test(address) || isBech32(address),
    caseInsensitive: false,
    expected,
    normalize: (address) =>
      isBech32(address) ? address.toLowerCase() : address,
  };
}

/** One of the three chains this service settles on, with its existing rules. */
function settledChain(
  chain: Chain,
  name: string,
  txId: CrossChainTxIdRule,
  caseInsensitive: boolean,
  evmChainId: number | null,
  depositLink: DepositLinkBuilder,
): CrossChainNetwork {
  return {
    id: chain,
    blockchain: NEAR_INTENTS_BLOCKCHAINS[chain],
    name,
    nativeSymbol: NATIVE_ASSET_CODES[chain],
    address: { ...CHAIN_ADDRESS_RULES[chain], caseInsensitive },
    txId,
    evmChainId,
    depositLink,
  };
}

/**
 * An EVM network: 0x + 40 hex addresses, stored EIP-55 like Monad's so one
 * account has one spelling, and an EIP-681 link when its chain id is verified.
 */
function evmNetwork(
  id: CrossChainNetworkId,
  name: string,
  nativeSymbol: string,
  chainId: number | null,
): CrossChainNetwork {
  return {
    id,
    blockchain: id,
    name,
    nativeSymbol,
    address: {
      isValid: isEvmAddress,
      caseInsensitive: true,
      expected: `a valid ${name} (EVM) address (0x + 40 hex)`,
      normalize: toChecksumAddress,
    },
    txId: EVM_TX_ID,
    evmChainId: chainId,
    depositLink: chainId === null ? null : memoless(eip681DepositLink(chainId)),
  };
}

/** A network whose rules are its own: its 1Click code is its id. */
function network(
  id: CrossChainNetworkId,
  name: string,
  nativeSymbol: string,
  address: CrossChainAddressRule,
  txId: CrossChainTxIdRule,
  depositLink: DepositLinkBuilder | null = null,
): CrossChainNetwork {
  return {
    id,
    blockchain: id,
    name,
    nativeSymbol,
    address,
    txId,
    evmChainId: null,
    depositLink: depositLink && memoless(depositLink),
  };
}

/** A hex-address network: one pattern, stored lowercase. */
function hexAddress(re: RegExp, expected: string): CrossChainAddressRule {
  return {
    isValid: (address) => re.test(address),
    caseInsensitive: true,
    expected,
    normalize: lowercase,
  };
}

/** A network with a case-sensitive address encoding: one pattern, kept as written. */
function exactAddress(re: RegExp, expected: string): CrossChainAddressRule {
  return {
    isValid: (address) => re.test(address),
    caseInsensitive: false,
    expected,
    normalize: identity,
  };
}

/**
 * Every network cross-chain swaps reach, by id: how its addresses and
 * transaction ids are spelled, and how a deposit on it is paid. A `Record`
 * over {@link CrossChainNetworkId}, so an id added to the list does not
 * compile until it has its rules. Tokens on any 1Click blockchain with no
 * entry here (`qtc`, `adi`) are not offered.
 *
 * Deposit links exist where the chain has a wallet-link standard: SEP-7,
 * Solana Pay, EIP-681 (with a verified chain id), BIP-21 and its copies, TON
 * transfer links and CIP-13. Everywhere else the payer sends to the deposit
 * address (and memo) with any wallet of that chain.
 */
export const CROSS_CHAIN_NETWORKS: Record<
  CrossChainNetworkId,
  CrossChainNetwork
> = {
  stellar: settledChain(
    'stellar',
    'Stellar',
    hexTxId(TX_HASH_RE, 'a Stellar transaction hash (64 hex)'),
    false,
    null,
    // SEP-7 carries the memo every Stellar deposit has.
    DEPOSIT_LINK_BUILDERS.stellar,
  ),
  solana: settledChain(
    'solana',
    'Solana',
    exactTxId(SOLANA_TX_ID_RE, 'a Solana signature (base58)'),
    false,
    null,
    memoless(DEPOSIT_LINK_BUILDERS.solana),
  ),
  monad: settledChain(
    'monad',
    'Monad',
    EVM_TX_ID,
    true,
    MONAD_CHAIN_IDS.public,
    memoless(DEPOSIT_LINK_BUILDERS.monad),
  ),

  eth: evmNetwork('eth', 'Ethereum', 'ETH', CROSS_CHAIN_EVM_CHAIN_IDS.eth),
  base: evmNetwork('base', 'Base', 'ETH', CROSS_CHAIN_EVM_CHAIN_IDS.base),
  arb: evmNetwork('arb', 'Arbitrum', 'ETH', CROSS_CHAIN_EVM_CHAIN_IDS.arb),
  op: evmNetwork('op', 'Optimism', 'ETH', CROSS_CHAIN_EVM_CHAIN_IDS.op),
  bsc: evmNetwork('bsc', 'BNB Chain', 'BNB', CROSS_CHAIN_EVM_CHAIN_IDS.bsc),
  pol: evmNetwork('pol', 'Polygon', 'POL', CROSS_CHAIN_EVM_CHAIN_IDS.pol),
  avax: evmNetwork('avax', 'Avalanche', 'AVAX', CROSS_CHAIN_EVM_CHAIN_IDS.avax),
  gnosis: evmNetwork(
    'gnosis',
    'Gnosis',
    'xDAI',
    CROSS_CHAIN_EVM_CHAIN_IDS.gnosis,
  ),
  bera: evmNetwork('bera', 'Berachain', 'BERA', CROSS_CHAIN_EVM_CHAIN_IDS.bera),
  scroll: evmNetwork(
    'scroll',
    'Scroll',
    'ETH',
    CROSS_CHAIN_EVM_CHAIN_IDS.scroll,
  ),
  xlayer: evmNetwork(
    'xlayer',
    'X Layer',
    'OKB',
    CROSS_CHAIN_EVM_CHAIN_IDS.xlayer,
  ),
  abs: evmNetwork('abs', 'Abstract', 'ETH', CROSS_CHAIN_EVM_CHAIN_IDS.abs),
  plasma: evmNetwork(
    'plasma',
    'Plasma',
    'XPL',
    CROSS_CHAIN_EVM_CHAIN_IDS.plasma,
  ),
  hood: evmNetwork('hood', 'Robinhood Chain', 'ETH', null),
  hypercore: evmNetwork('hypercore', 'Hyperliquid', 'HYPE', null),

  btc: network(
    'btc',
    'Bitcoin',
    'BTC',
    utxoAddress(
      BTC_BECH32_RE,
      BTC_BASE58_RE,
      'a valid Bitcoin address (bc1..., 1... or 3...)',
    ),
    HEX_TX_ID,
    bip21DepositLink('bitcoin'),
  ),
  ltc: network(
    'ltc',
    'Litecoin',
    'LTC',
    utxoAddress(
      LTC_BECH32_RE,
      LTC_BASE58_RE,
      'a valid Litecoin address (ltc1..., L..., M... or 3...)',
    ),
    HEX_TX_ID,
    bip21DepositLink('litecoin'),
  ),
  doge: network(
    'doge',
    'Dogecoin',
    'DOGE',
    utxoAddress(
      null,
      DOGE_BASE58_RE,
      'a valid Dogecoin address (D..., A... or 9...)',
    ),
    HEX_TX_ID,
    bip21DepositLink('dogecoin'),
  ),
  bch: network(
    'bch',
    'Bitcoin Cash',
    'BCH',
    utxoAddress(
      BCH_CASHADDR_RE,
      BTC_BASE58_RE,
      'a valid Bitcoin Cash address (cashaddr q... or p..., with or ' +
        'without bitcoincash:, or legacy 1... / 3...)',
    ),
    HEX_TX_ID,
    bip21DepositLink('bitcoincash'),
  ),
  dash: network(
    'dash',
    'Dash',
    'DASH',
    utxoAddress(null, DASH_BASE58_RE, 'a valid Dash address (X... or 7...)'),
    HEX_TX_ID,
    bip21DepositLink('dash'),
  ),
  zec: network(
    'zec',
    'Zcash',
    'ZEC',
    utxoAddress(
      ZEC_UNIFIED_RE,
      ZEC_TRANSPARENT_RE,
      'a valid Zcash transparent (t1... or t3...) or unified (u1...) address',
    ),
    HEX_TX_ID,
    bip21DepositLink('zcash'),
  ),

  xrp: network(
    'xrp',
    'XRP Ledger',
    'XRP',
    exactAddress(XRP_ADDRESS_RE, 'a valid XRP Ledger address (r..., base58)'),
    HEX_TX_ID,
  ),
  tron: network(
    'tron',
    'Tron',
    'TRX',
    exactAddress(TRON_ADDRESS_RE, 'a valid Tron address (T..., 34 base58)'),
    HEX_TX_ID,
  ),
  ton: network(
    'ton',
    'TON',
    'TON',
    {
      isValid: (address) =>
        TON_FRIENDLY_ADDRESS_RE.test(address) ||
        TON_RAW_ADDRESS_RE.test(address),
      caseInsensitive: false,
      expected:
        'a valid TON address (48-character user-friendly form, or raw 0:<64 hex>)',
      // Raw form is hex; the user-friendly form is base64 and case-sensitive.
      normalize: (address) =>
        TON_RAW_ADDRESS_RE.test(address) ? address.toLowerCase() : address,
    },
    {
      isValid: (id) => TON_TX_ID_RE.test(id),
      expected: 'a TON transaction hash (64 hex, or 44 base64)',
      normalize: (id) => (TX_HASH_RE.test(id) ? id.toLowerCase() : id),
    },
    tonDepositLink,
  ),
  near: network(
    'near',
    'NEAR',
    'NEAR',
    exactAddress(
      NEAR_ACCOUNT_ID_RE,
      'a valid NEAR account id (named, e.g. alice.near, or 64-hex implicit)',
    ),
    exactTxId(BASE58_DIGEST_RE, 'a NEAR transaction hash (base58)'),
  ),
  sui: network(
    'sui',
    'Sui',
    'SUI',
    hexAddress(SUI_ADDRESS_RE, 'a valid Sui address (0x + 64 hex)'),
    exactTxId(BASE58_DIGEST_RE, 'a Sui transaction digest (base58)'),
  ),
  aptos: network(
    'aptos',
    'Aptos',
    'APT',
    hexAddress(
      SHORT_HEX_ADDRESS_RE,
      'a valid Aptos address (0x + up to 64 hex)',
    ),
    hexTxId(EVM_TX_ID_RE, 'an Aptos transaction hash (0x + 64 hex)'),
  ),
  movement: network(
    'movement',
    'Movement',
    'MOVE',
    hexAddress(
      SHORT_HEX_ADDRESS_RE,
      'a valid Movement address (0x + up to 64 hex)',
    ),
    hexTxId(EVM_TX_ID_RE, 'a Movement transaction hash (0x + 64 hex)'),
  ),
  starknet: network(
    'starknet',
    'Starknet',
    'STRK',
    hexAddress(
      SHORT_HEX_ADDRESS_RE,
      'a valid Starknet address (0x + up to 64 hex)',
    ),
    hexTxId(
      STARKNET_TX_ID_RE,
      'a Starknet transaction hash (0x + up to 64 hex)',
    ),
  ),
  cardano: network(
    'cardano',
    'Cardano',
    'ADA',
    exactAddress(CARDANO_ADDRESS_RE, 'a valid Cardano address (addr1...)'),
    HEX_TX_ID,
    cardanoDepositLink,
  ),
  aleo: network(
    'aleo',
    'Aleo',
    'ALEO',
    exactAddress(
      ALEO_ADDRESS_RE,
      'a valid Aleo address (aleo1 + 58 characters)',
    ),
    exactTxId(ALEO_TX_ID_RE, 'an Aleo transaction id (at1...)'),
  ),
  fogo: network(
    'fogo',
    'Fogo',
    'FOGO',
    {
      isValid: isSolanaAddress,
      caseInsensitive: false,
      expected: 'a valid Fogo address (base58, 32 bytes)',
      normalize: identity,
    },
    exactTxId(SOLANA_TX_ID_RE, 'a Fogo signature (base58)'),
  ),
};

export function isCrossChainNetworkId(
  value: unknown,
): value is CrossChainNetworkId {
  return (
    typeof value === 'string' &&
    (CROSS_CHAIN_NETWORK_IDS as readonly string[]).includes(value)
  );
}

const NETWORK_BY_BLOCKCHAIN = new Map<string, CrossChainNetwork>(
  Object.values(CROSS_CHAIN_NETWORKS).map((n) => [n.blockchain, n]),
);

/** The network 1Click's `blockchain` names, when this service reaches it. */
export function networkByBlockchain(
  blockchain: string,
): CrossChainNetwork | undefined {
  return NETWORK_BY_BLOCKCHAIN.get(blockchain);
}

/**
 * The wallet link that pays a deposit on its origin network; null when that
 * network has no link this service builds, or the link could not carry the
 * memo 1Click issued.
 */
export function depositLink(terms: DepositTerms): string | null {
  const build = CROSS_CHAIN_NETWORKS[terms.asset.chain].depositLink;
  return build ? build(terms) : null;
}
