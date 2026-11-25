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

/** A deployment with deposit addresses on `relayed` chains only. */
function catalogFor(
  environment: 'prod' | 'dev',
  relayed: string[] = ['monad', 'arc'],
) {
  const config = {
    get: (key: string) =>
      key === 'stellar' ? { network: 'testnet' } : undefined,
  } as never;
  const deposits = {
    isEnabled: jest.fn((chain: string) => relayed.includes(chain)),
  };
  return new PaymentNetworkCatalog(
    config,
    sandbox as never,
    deposits as never,
  ).forConsumer({
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

  it('on the test networks: the four chains natively, the rest where the sandbox reaches', () => {
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

  it('reports Arc unavailable, on both tiers, while the deployment issues no Arc deposit addresses', () => {
    for (const environment of ['prod', 'dev'] as const) {
      const byId = Object.fromEntries(
        catalogFor(environment, []).data.map((n) => [n.id, n]),
      );
      expect(byId.arc).toMatchObject({ available: false, asset: null });
      expect(byId.arc.reason).toMatch(
        /^Payment links on Arc are not available on this deployment/,
      );
      // The reason names no setting.
      expect(byId.arc.reason).not.toMatch(/RELAYER|PRIVATE_KEY/);
      // Monad keeps its direct links without a relayer, as it always had them.
      expect(byId.monad).toMatchObject({ available: true, reason: null });
      expect(byId.stellar).toMatchObject({ available: true, reason: null });
    }
  });
});
