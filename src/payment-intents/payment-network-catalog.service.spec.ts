import { PaymentNetworkCatalog } from '@/payment-intents/payment-network-catalog.service';

const sandbox = {
  availability: jest.fn((network: string) =>
    network === 'base'
      ? {
          network,
          available: true,
          reason: null,
          asset: { symbol: 'USDC', contract: '0xUSDC', decimals: 6 },
        }
      : { network, available: false, reason: 'not here yet', asset: null },
  ),
};

function catalogFor(environment: 'prod' | 'dev') {
  const config = {
    get: (key: string) =>
      key === 'stellar' ? { network: 'testnet' } : undefined,
  } as never;
  return new PaymentNetworkCatalog(config, sandbox as never).forConsumer({
    username: 'cosmos_u1',
    environment,
  } as never);
}

describe('PaymentNetworkCatalog', () => {
  it('offers every network on mainnet, in any asset', () => {
    const { data } = catalogFor('prod');
    expect(data).toHaveLength(36);
    expect(data.every((n) => n.available && n.asset === null)).toBe(true);
    expect(data.find((n) => n.id === 'arc')).toMatchObject({
      name: 'Arc',
      settlesThroughDeposits: false,
    });
    expect(data.find((n) => n.id === 'btc')).toMatchObject({
      network: 'public',
      settlesThroughDeposits: true,
    });
    expect(data.find((n) => n.id === 'stellar')?.settlesThroughDeposits).toBe(
      false,
    );
  });

  it('on the test networks: the three chains natively, the rest where the sandbox reaches', () => {
    const { data } = catalogFor('dev');
    const byId = Object.fromEntries(data.map((n) => [n.id, n]));
    expect(byId.solana).toMatchObject({ available: true, network: 'testnet' });
    // Arc Testnet is a real test network: dev keys pay Arc links natively.
    expect(byId.arc).toMatchObject({
      available: true,
      network: 'testnet',
      settlesThroughDeposits: false,
      asset: null,
    });
    expect(byId.base).toMatchObject({
      available: true,
      asset: { symbol: 'USDC', contract: '0xUSDC', decimals: 6 },
    });
    expect(byId.btc).toMatchObject({
      available: false,
      reason: 'not here yet',
    });
  });
});
