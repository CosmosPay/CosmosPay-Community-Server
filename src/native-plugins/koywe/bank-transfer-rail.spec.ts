import {
  conversionTarget,
  railTokenFor,
  type RailSettings,
} from '@/native-plugins/koywe/bank-transfer-rail';

const SETTINGS: RailSettings = {
  networks: ['public', 'testnet'],
  minArs: 1000,
  maxArs: 5_000_000,
  sandbox: { network: 'POLYGON', token: 'USDT' },
};

/** Every mainnet pair the contract lists, as each chain's explorer spells it. */
const PUBLIC_PAIRS = [
  [1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'ETHEREUM', 'USDC', 6],
  [1, '0xdAC17F958D2ee523a2206206994597C13D831ec7', 'ETHEREUM', 'USDT', 6],
  [137, '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 'POLYGON', 'USDC', 6],
  [137, '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 'POLYGON', 'USDT', 6],
  [8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'BASE', 'USDC', 6],
  [8453, '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 'BASE', 'USDT', 6],
  [56, '0x55d398326f99059fF775485246999027B3197955', 'BSC', 'USDT', 18],
] as const;

const terms = (over: Partial<Parameters<typeof railTokenFor>[0]> = {}) => ({
  network: 'public' as const,
  currency: 'ARS',
  amount: '15000',
  chainId: 137,
  tokenAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  ...over,
});

const SANDBOX_USDT = { symbol: 'USDT', decimals: 18 };

describe('which requests a bank transfer can pay', () => {
  it.each(PUBLIC_PAIRS)(
    'pays chain %d token %s, in any case, converting on %s to %s',
    (chainId, address, network, token, decimals) => {
      for (const spelled of [
        address,
        address.toLowerCase(),
        `0x${address.slice(2).toUpperCase()}`,
      ]) {
        const at = terms({ chainId, tokenAddress: spelled });
        expect(railTokenFor(at, null, SETTINGS)).toEqual({
          symbol: token,
          decimals,
        });
        expect(
          conversionTarget(
            'public',
            chainId,
            spelled,
            { symbol: token, decimals },
            SETTINGS.sandbox,
          ),
        ).toEqual({ network, token });
      }
    },
  );

  it('pays no other mainnet pair: another token, another chain, a known token on the wrong chain', () => {
    for (const over of [
      {
        chainId: 42161,
        tokenAddress: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      },
      {
        chainId: 137,
        tokenAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      },
      {
        chainId: 1,
        tokenAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      },
      {
        chainId: 56,
        tokenAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      },
    ]) {
      expect(railTokenFor(terms(over), null, SETTINGS)).toBeNull();
    }
  });

  it('takes ARS only, as given', () => {
    for (const currency of ['ars', 'USD', 'BRL', '']) {
      expect(railTokenFor(terms({ currency }), null, SETTINGS)).toBeNull();
    }
  });

  it('takes amounts within the bounds, inclusive, with at most two decimals', () => {
    for (const amount of ['1000', '1000.00', '4999999.99', '5000000']) {
      expect(railTokenFor(terms({ amount }), null, SETTINGS)).not.toBeNull();
    }
    for (const amount of [
      '999.99',
      '5000000.01',
      '15000.001',
      '1e4',
      '-15000',
    ]) {
      expect(railTokenFor(terms({ amount }), null, SETTINGS)).toBeNull();
    }
    expect(
      railTokenFor(terms({ amount: '20000' }), null, {
        ...SETTINGS,
        maxArs: 10000,
      }),
    ).toBeNull();
  });

  it('pays nothing on a network the deployment does not serve', () => {
    expect(
      railTokenFor(terms(), null, { ...SETTINGS, networks: ['testnet'] }),
    ).toBeNull();
  });

  it('maps every test pair the P2P sandbox market lists to the sandbox network and token', () => {
    const test = terms({
      network: 'testnet',
      chainId: 421614,
      tokenAddress: '0x25f5D414F85b7f4668ADe4E557ef234023208771',
    });

    expect(railTokenFor(test, SANDBOX_USDT, SETTINGS)).toEqual(SANDBOX_USDT);
    expect(
      conversionTarget(
        'testnet',
        421614,
        test.tokenAddress,
        SANDBOX_USDT,
        SETTINGS.sandbox,
      ),
    ).toEqual({ network: 'POLYGON', token: 'USDT' });
    // A pair the market does not list is not paid on the sandbox either.
    expect(railTokenFor(test, null, SETTINGS)).toBeNull();
    // A mainnet pair on the sandbox is a test pair like any other.
    expect(
      railTokenFor({ ...terms(), network: 'testnet' }, null, SETTINGS),
    ).toBeNull();
  });
});
