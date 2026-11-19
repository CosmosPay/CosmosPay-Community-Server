import { toChecksumAddress } from '@/chains/chain-address';
import { CROSS_CHAIN_EVM_CHAIN_IDS } from '@/cross-chain-swaps/cross-chain-swaps.constants';
import { MONAD_CHAIN_IDS } from '@/chains/chains.constants';
import { P2P_NETWORK_IDS, P2P_NETWORKS } from '@/p2p/p2p-networks';
import { SANDBOX_NETWORKS } from '@/sandbox-settlement/sandbox-settlement.constants';

describe('P2P networks', () => {
  it('runs every network on at least one tier', () => {
    for (const id of P2P_NETWORK_IDS) {
      const { tiers } = P2P_NETWORKS[id];
      expect(tiers.public !== null || tiers.testnet !== null).toBe(true);
    }
  });

  it('takes mainnet chain ids only from the verified tables', () => {
    for (const id of P2P_NETWORK_IDS) {
      const tier = P2P_NETWORKS[id].tiers.public;
      if (!tier) continue;
      const expected =
        id === 'monad'
          ? MONAD_CHAIN_IDS.public
          : (CROSS_CHAIN_EVM_CHAIN_IDS as Record<string, number>)[id];
      expect(tier.chainId).toBe(expected);
      expect(tier.defaultRpcUrl).toBeNull();
    }
  });

  it('takes test networks and their test stablecoin from the sandbox', () => {
    for (const id of P2P_NETWORK_IDS) {
      const tier = P2P_NETWORKS[id].tiers.testnet;
      const sandbox = SANDBOX_NETWORKS[id];
      if (!tier) {
        expect(sandbox.kind).not.toBe('evm');
        continue;
      }
      if (sandbox.kind !== 'evm') throw new Error(`${id} is not EVM`);
      expect(tier.chainId).toBe(sandbox.chainId);
      expect(tier.sandboxCusd).toBe(sandbox.stablecoin.issuer === 'cusd');
    }
  });

  it('lists tokens by their EIP-55 address, with sane decimals', () => {
    for (const id of P2P_NETWORK_IDS) {
      for (const tier of Object.values(P2P_NETWORKS[id].tiers)) {
        for (const token of tier?.tokens ?? []) {
          expect(token.address).toBe(toChecksumAddress(token.address));
          expect([6, 18]).toContain(token.decimals);
        }
      }
    }
  });
});
