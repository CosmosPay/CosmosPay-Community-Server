import { MONAD_CHAIN_IDS } from '@/chains/chains.constants';
import {
  CROSS_CHAIN_NETWORKS,
  depositLink,
  isCrossChainNetworkId,
  networkByBlockchain,
} from '@/cross-chain-swaps/cross-chain-networks';
import {
  CROSS_CHAIN_EVM_CHAIN_IDS,
  CROSS_CHAIN_NETWORK_IDS,
  type CrossChainNetworkId,
} from '@/cross-chain-swaps/cross-chain-swaps.constants';

const EVM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const EVM_LOWER = EVM.toLowerCase();
const STELLAR = 'GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG';
const SOLANA = '13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK';
const HEX64 = 'ab'.repeat(32);
const BTC_BECH32 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const BTC_LEGACY = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const CASHADDR = 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
const ZEC_UNIFIED = `u1${'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(4)}`;
const TON_FRIENDLY = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const CARDANO =
  'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x';
const ALEO = 'aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px';
const BASE58_DIGEST = '6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm';
const SOLANA_SIGNATURE = '5'.repeat(88);

/** 1Click's `GET /v0/tokens` blockchain codes (2026-10-25). */
const ONE_CLICK_BLOCKCHAINS = [
  'near',
  'eth',
  'sol',
  'base',
  'aptos',
  'bsc',
  'gnosis',
  'arb',
  'op',
  'hood',
  'pol',
  'plasma',
  'starknet',
  'monad',
  'xlayer',
  'avax',
  'aleo',
  'hypercore',
  'sui',
  'btc',
  'bera',
  'tron',
  'ton',
  'stellar',
  'scroll',
  'movement',
  'zec',
  'qtc',
  'abs',
  'fogo',
  'doge',
  'xrp',
  'cardano',
  'ltc',
  'bch',
  'dash',
  'adi',
];

const EVM_IDS = [
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
] as const;

/** Addresses each network must accept, and ones it must refuse. */
const ADDRESSES: Record<
  CrossChainNetworkId,
  { valid: string[]; invalid: string[] }
> = {
  stellar: { valid: [STELLAR], invalid: [EVM, SOLANA] },
  solana: { valid: [SOLANA], invalid: [EVM, STELLAR] },
  ...(Object.fromEntries(
    EVM_IDS.map((id) => [
      id,
      { valid: [EVM, EVM_LOWER], invalid: [SOLANA, '0x1234', `0x${HEX64}`] },
    ]),
  ) as Record<
    (typeof EVM_IDS)[number],
    { valid: string[]; invalid: string[] }
  >),
  btc: {
    valid: [
      BTC_BECH32,
      BTC_BECH32.toUpperCase(),
      'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297',
      BTC_LEGACY,
      '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
    ],
    invalid: [
      // Mixed case: BIP-173 refuses it.
      'bc1QW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      // Testnet.
      'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      'ltc1qg82l7kq7m4xsxvqtyp6c7vq7h0j7v9ykwyzd4m',
      EVM,
    ],
  },
  ltc: {
    valid: [
      'ltc1qg82l7kq7m4xsxvqtyp6c7vq7h0j7v9ykwyzd4m',
      'LVg2kJoFNg45Nbpy53h7Fe1wKyeXVRhMH9',
      'MQMcJhpWHYVeQArcZR3sBgyPZxxRtnH441',
    ],
    invalid: [BTC_BECH32, BTC_LEGACY, 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L'],
  },
  doge: {
    valid: ['DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L'],
    invalid: [BTC_LEGACY, 'D0H5yaieqoZN36fDVciNyRueRGvGLR3mr7'],
  },
  bch: {
    valid: [
      CASHADDR,
      `bitcoincash:${CASHADDR}`,
      `bitcoincash:${CASHADDR}`.toUpperCase(),
      BTC_LEGACY,
    ],
    invalid: [`ecash:${CASHADDR}`, CASHADDR.slice(0, -1), BTC_BECH32],
  },
  dash: {
    valid: ['XpESxaUmonkq8RaLLp46Brx2K39ggQe226'],
    invalid: [BTC_LEGACY, 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L'],
  },
  zec: {
    valid: ['t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs', ZEC_UNIFIED],
    invalid: [
      // Sapling and testnet addresses are not accepted.
      'zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly',
      'tmHsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs',
      BTC_LEGACY,
    ],
  },
  xrp: {
    valid: ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
    invalid: [
      // An X-address.
      'XV5sbjUmgPpvXv4ixFWZ5ptAYZ6PD28Sq49uo34VyjnmK5H',
      BTC_LEGACY,
    ],
  },
  tron: {
    valid: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'],
    invalid: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6', EVM],
  },
  ton: {
    valid: [
      TON_FRIENDLY,
      'UQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
      `0:${HEX64}`,
      `-1:${HEX64.toUpperCase()}`,
    ],
    invalid: [TON_FRIENDLY.slice(0, -1), `1:${HEX64}`, EVM],
  },
  near: {
    valid: [
      'alice.near',
      'cosmospay.near',
      'sub.alice-bob_1.near',
      'a1',
      `${'98793cd91a3f870fb126f66285808c7e'.repeat(2)}`,
      EVM_LOWER,
    ],
    invalid: [
      'Alice.near',
      'a',
      'alice..near',
      '-alice.near',
      'alice_.near',
      'a'.repeat(65),
    ],
  },
  sui: {
    valid: [`0x${HEX64}`, `0x${HEX64.toUpperCase()}`],
    invalid: [EVM, HEX64],
  },
  aptos: {
    valid: ['0x1', `0x${HEX64}`],
    invalid: ['0x', `0x${HEX64}a`, 'apt.near'],
  },
  movement: {
    valid: ['0x1', `0x${HEX64}`],
    invalid: ['0x', `0x${HEX64}a`],
  },
  starknet: {
    valid: [`0x${HEX64.slice(1)}`, `0x${HEX64}`],
    invalid: ['0x', SOLANA],
  },
  cardano: {
    valid: [CARDANO],
    invalid: [
      // Byron and testnet addresses are not accepted.
      'Ae2tdPwUPEZ76BjmWDTS7poTekAvNqBjgfthF92pSLSDVpRVnLP7meaFhVd',
      CARDANO.replace('addr1', 'addr_test1'),
    ],
  },
  aleo: { valid: [ALEO], invalid: [ALEO.slice(0, -1), EVM] },
  fogo: { valid: [SOLANA], invalid: [EVM, STELLAR] },
};

/** Transaction ids each network must accept, and ones it must refuse. */
const TX_IDS: Record<
  CrossChainNetworkId,
  { valid: string[]; invalid: string[] }
> = {
  stellar: { valid: [HEX64], invalid: [`0x${HEX64}`] },
  solana: { valid: [SOLANA_SIGNATURE], invalid: [HEX64.slice(2)] },
  ...(Object.fromEntries(
    EVM_IDS.map((id) => [
      id,
      { valid: [`0x${HEX64}`], invalid: [HEX64, `0x${HEX64.slice(2)}`] },
    ]),
  ) as Record<
    (typeof EVM_IDS)[number],
    { valid: string[]; invalid: string[] }
  >),
  ...(Object.fromEntries(
    ['btc', 'ltc', 'doge', 'bch', 'dash', 'zec', 'xrp', 'tron', 'cardano'].map(
      (id) => [id, { valid: [HEX64], invalid: [`0x${HEX64}`, SOLANA] }],
    ),
  ) as Record<
    | 'btc'
    | 'ltc'
    | 'doge'
    | 'bch'
    | 'dash'
    | 'zec'
    | 'xrp'
    | 'tron'
    | 'cardano',
    { valid: string[]; invalid: string[] }
  >),
  ton: {
    valid: [HEX64, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456='],
    invalid: [`0x${HEX64}`],
  },
  near: { valid: [BASE58_DIGEST], invalid: [HEX64, SOLANA_SIGNATURE] },
  sui: { valid: [BASE58_DIGEST], invalid: [`0x${HEX64}`] },
  aptos: { valid: [`0x${HEX64}`], invalid: [HEX64] },
  movement: { valid: [`0x${HEX64}`], invalid: [HEX64] },
  starknet: { valid: [`0x${HEX64.slice(1)}`], invalid: [HEX64] },
  aleo: {
    valid: [`at1${'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2).slice(0, 58)}`],
    invalid: [HEX64],
  },
  fogo: { valid: [SOLANA_SIGNATURE], invalid: [HEX64] },
};

describe('CROSS_CHAIN_NETWORKS', () => {
  it('has one entry per id, keyed by that id', () => {
    for (const id of CROSS_CHAIN_NETWORK_IDS) {
      expect(CROSS_CHAIN_NETWORKS[id].id).toBe(id);
      expect(isCrossChainNetworkId(id)).toBe(true);
    }
    expect(Object.keys(CROSS_CHAIN_NETWORKS)).toHaveLength(
      CROSS_CHAIN_NETWORK_IDS.length,
    );
    expect(isCrossChainNetworkId('qtc')).toBe(false);
  });

  it('reaches every 1Click blockchain but qtc and adi, by its 1Click code', () => {
    const reached = ONE_CLICK_BLOCKCHAINS.filter((b) => networkByBlockchain(b));
    expect(reached).toHaveLength(ONE_CLICK_BLOCKCHAINS.length - 2);
    expect(networkByBlockchain('qtc')).toBeUndefined();
    expect(networkByBlockchain('adi')).toBeUndefined();
    // The three chains this service settles on keep their own ids.
    expect(networkByBlockchain('sol')?.id).toBe('solana');
    expect(networkByBlockchain('stellar')?.id).toBe('stellar');
    expect(networkByBlockchain('monad')?.id).toBe('monad');
    expect(networkByBlockchain('eth')?.id).toBe('eth');
    expect(networkByBlockchain('solana')).toBeUndefined();
  });

  it('names each network for display', () => {
    const names = Object.fromEntries(
      Object.values(CROSS_CHAIN_NETWORKS).map((n) => [n.id, n.name]),
    );
    expect(names).toEqual({
      stellar: 'Stellar',
      solana: 'Solana',
      monad: 'Monad',
      eth: 'Ethereum',
      base: 'Base',
      arb: 'Arbitrum',
      op: 'Optimism',
      bsc: 'BNB Chain',
      pol: 'Polygon',
      avax: 'Avalanche',
      gnosis: 'Gnosis',
      bera: 'Berachain',
      scroll: 'Scroll',
      xlayer: 'X Layer',
      abs: 'Abstract',
      plasma: 'Plasma',
      hood: 'Robinhood Chain',
      hypercore: 'Hyperliquid',
      btc: 'Bitcoin',
      ltc: 'Litecoin',
      doge: 'Dogecoin',
      bch: 'Bitcoin Cash',
      dash: 'Dash',
      zec: 'Zcash',
      xrp: 'XRP Ledger',
      tron: 'Tron',
      ton: 'TON',
      near: 'NEAR',
      sui: 'Sui',
      aptos: 'Aptos',
      movement: 'Movement',
      starknet: 'Starknet',
      cardano: 'Cardano',
      aleo: 'Aleo',
      fogo: 'Fogo',
    });
  });

  describe('addresses', () => {
    for (const id of CROSS_CHAIN_NETWORK_IDS) {
      it(`${id}: accepts its own shapes and refuses others`, () => {
        const { address } = CROSS_CHAIN_NETWORKS[id];
        for (const valid of ADDRESSES[id].valid) {
          expect([valid, address.isValid(valid)]).toEqual([valid, true]);
        }
        for (const invalid of ADDRESSES[id].invalid) {
          expect([invalid, address.isValid(invalid)]).toEqual([invalid, false]);
        }
      });
    }

    it('stores one spelling per account', () => {
      const { stellar, solana, monad, eth, sui, btc, bch, ton, near, xrp } =
        CROSS_CHAIN_NETWORKS;
      // Stellar, Solana and Monad keep the rules they always had.
      expect(stellar.address.normalize(STELLAR)).toBe(STELLAR);
      expect(solana.address.normalize(SOLANA)).toBe(SOLANA);
      expect(monad.address.normalize(EVM_LOWER)).toBe(EVM);
      // Every EVM network stores EIP-55, as Monad does.
      expect(eth.address.normalize(EVM_LOWER)).toBe(EVM);
      expect(sui.address.normalize(`0x${HEX64.toUpperCase()}`)).toBe(
        `0x${HEX64}`,
      );
      expect(btc.address.normalize(BTC_BECH32.toUpperCase())).toBe(BTC_BECH32);
      expect(btc.address.normalize(BTC_LEGACY)).toBe(BTC_LEGACY);
      expect(
        bch.address.normalize(`BITCOINCASH:${CASHADDR.toUpperCase()}`),
      ).toBe(`bitcoincash:${CASHADDR}`);
      expect(ton.address.normalize(`0:${HEX64.toUpperCase()}`)).toBe(
        `0:${HEX64}`,
      );
      expect(ton.address.normalize(TON_FRIENDLY)).toBe(TON_FRIENDLY);
      expect(near.address.normalize('alice.near')).toBe('alice.near');
      expect(xrp.address.normalize('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh')).toBe(
        'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
      );
    });

    it('compares contracts case-insensitively only where addresses are hex', () => {
      const insensitive = CROSS_CHAIN_NETWORK_IDS.filter(
        (id) => CROSS_CHAIN_NETWORKS[id].address.caseInsensitive,
      );
      expect(insensitive).toEqual([
        ...EVM_IDS,
        'sui',
        'aptos',
        'movement',
        'starknet',
      ]);
    });
  });

  describe('transaction ids', () => {
    for (const id of CROSS_CHAIN_NETWORK_IDS) {
      it(`${id}: accepts its own shapes and refuses others`, () => {
        const { txId } = CROSS_CHAIN_NETWORKS[id];
        for (const valid of TX_IDS[id].valid) {
          expect([valid, txId.isValid(valid)]).toEqual([valid, true]);
        }
        for (const invalid of TX_IDS[id].invalid) {
          expect([invalid, txId.isValid(invalid)]).toEqual([invalid, false]);
        }
      });
    }

    it('stores hex lowercase and keeps base58 and base64 as written', () => {
      const { stellar, eth, btc, solana, near, ton } = CROSS_CHAIN_NETWORKS;
      expect(stellar.txId.normalize(HEX64.toUpperCase())).toBe(HEX64);
      expect(eth.txId.normalize(`0x${HEX64.toUpperCase()}`)).toBe(`0x${HEX64}`);
      expect(btc.txId.normalize(HEX64.toUpperCase())).toBe(HEX64);
      expect(solana.txId.normalize(BASE58_DIGEST)).toBe(BASE58_DIGEST);
      expect(near.txId.normalize(BASE58_DIGEST)).toBe(BASE58_DIGEST);
      const base64 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456=';
      expect(ton.txId.normalize(base64)).toBe(base64);
      expect(ton.txId.normalize(HEX64.toUpperCase())).toBe(HEX64);
    });
  });

  describe('deposit links', () => {
    it('exist where the chain has a wallet-link standard, and only there', () => {
      const linked = CROSS_CHAIN_NETWORK_IDS.filter(
        (id) => CROSS_CHAIN_NETWORKS[id].depositLink !== null,
      );
      expect(linked).toEqual([
        'stellar',
        'solana',
        'monad',
        ...Object.keys(CROSS_CHAIN_EVM_CHAIN_IDS),
        'btc',
        'ltc',
        'doge',
        'bch',
        'dash',
        'zec',
        'ton',
        'cardano',
      ]);
    });

    it('name a chain id only where it was verified', () => {
      const ids = Object.fromEntries(
        CROSS_CHAIN_NETWORK_IDS.filter(
          (id) => CROSS_CHAIN_NETWORKS[id].evmChainId !== null,
        ).map((id) => [id, CROSS_CHAIN_NETWORKS[id].evmChainId]),
      );
      expect(ids).toEqual({
        monad: MONAD_CHAIN_IDS.public,
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
      });
      expect(CROSS_CHAIN_NETWORKS.hood.evmChainId).toBeNull();
      expect(CROSS_CHAIN_NETWORKS.hypercore.evmChainId).toBeNull();
    });

    it('build each EVM link on its own chain id, a token as an ERC-20 transfer', () => {
      for (const [id, chainId] of Object.entries(CROSS_CHAIN_EVM_CHAIN_IDS)) {
        const network = CROSS_CHAIN_NETWORKS[id as CrossChainNetworkId];
        expect(
          depositLink({
            address: EVM,
            memo: null,
            amount: '1',
            asset: {
              chain: network.id,
              chainName: network.name,
              symbol: network.nativeSymbol,
              assetId: 'x',
              decimals: 18,
              contract: null,
              priceUsd: null,
            },
          }),
        ).toBe(`ethereum:${EVM}@${chainId}?value=1000000000000000000`);
      }
      const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
      expect(
        depositLink({
          address: EVM,
          memo: null,
          amount: '25',
          asset: {
            chain: 'eth',
            chainName: 'Ethereum',
            symbol: 'USDC',
            assetId: 'x',
            decimals: 6,
            contract: usdc,
            priceUsd: 1,
          },
        }),
      ).toBe(`ethereum:${usdc}@1/transfer?address=${EVM}&uint256=25000000`);
    });

    it('build the UTXO links with each coin’s own scheme', () => {
      const schemes = {
        btc: 'bitcoin',
        ltc: 'litecoin',
        doge: 'dogecoin',
        bch: 'bitcoincash',
        dash: 'dash',
        zec: 'zcash',
      } as const;
      for (const [id, scheme] of Object.entries(schemes)) {
        expect(
          depositLink({
            address: 'deposit-address',
            memo: null,
            amount: '0.5',
            asset: {
              chain: id as CrossChainNetworkId,
              chainName: id,
              symbol: id.toUpperCase(),
              assetId: 'x',
              decimals: 8,
              contract: null,
              priceUsd: null,
            },
          }),
        ).toBe(`${scheme}:deposit-address?amount=0.5`);
      }
    });

    it('drop a link that could not carry the memo 1Click issued', () => {
      expect(
        depositLink({
          address: TON_FRIENDLY,
          memo: '12345',
          amount: '1',
          asset: {
            chain: 'ton',
            chainName: 'TON',
            symbol: 'TON',
            assetId: 'x',
            decimals: 9,
            contract: null,
            priceUsd: null,
          },
        }),
      ).toBeNull();
    });
  });
});
