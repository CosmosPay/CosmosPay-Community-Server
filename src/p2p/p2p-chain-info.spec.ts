import { p2pChainInfo } from '@/p2p/p2p-chain-info';
import { P2P_NETWORK_IDS, P2P_NETWORKS } from '@/p2p/p2p-networks';

describe('P2P chain info', () => {
  it('gives a test network its public node, explorer and coin from the public tables', () => {
    expect(p2pChainInfo('base', 'testnet')).toEqual({
      nativeSymbol: 'ETH',
      explorerUrl: 'https://sepolia.basescan.org',
      rpcUrl: 'https://sepolia.base.org',
    });
  });

  it('gives a mainnet network the receipts’ explorer, and a public node only where one is listed', () => {
    expect(p2pChainInfo('base', 'public')).toEqual({
      nativeSymbol: 'ETH',
      explorerUrl: 'https://basescan.org',
      rpcUrl: null,
    });
    expect(p2pChainInfo('monad', 'public')).toEqual({
      nativeSymbol: 'MON',
      explorerUrl: 'https://monadscan.com',
      rpcUrl: 'https://rpc.monad.xyz',
    });
  });

  it('answers every network the market runs on, with an https explorer or none', () => {
    for (const id of P2P_NETWORK_IDS) {
      for (const tier of ['public', 'testnet'] as const) {
        if (!P2P_NETWORKS[id].tiers[tier]) continue;
        const info = p2pChainInfo(id, tier);
        expect(info.nativeSymbol).toMatch(/^[A-Za-z]{2,6}$/);
        if (info.explorerUrl)
          expect(info.explorerUrl).toMatch(/^https:\/\/[^/]+/);
        if (info.rpcUrl) expect(info.rpcUrl).toMatch(/^https:\/\//);
      }
    }
  });
});
