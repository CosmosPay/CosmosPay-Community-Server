import type { StellarNetwork } from '@/config/configuration';
import { DEFAULT_MONAD_RPC } from '@/config/config.constants';
import { CROSS_CHAIN_NETWORKS } from '@/cross-chain-swaps/cross-chain-networks';
import { paymentExplorerTxUrl } from '@/payment-intents/payment-explorers';
import { P2P_NETWORKS, type P2pNetworkId } from '@/p2p/p2p-networks';
import { SANDBOX_NETWORKS } from '@/sandbox-settlement/sandbox-settlement.constants';

/**
 * What a wallet needs to add or show a P2P network, from public constants
 * only: never the operator's node (`P2P_RPC_URLS_*` may carry an API key in
 * its URL). Kept apart from `p2p-networks.ts`, which the configuration loads,
 * so the explorer and cross-chain tables are read only by the routes.
 */
export interface P2pChainInfo {
  /** The chain's coin, as wallets name it. */
  nativeSymbol: string;
  /** An Etherscan-style explorer: append `/tx/<hash>` or `/address/<address>`. */
  explorerUrl: string | null;
  /** A public node for `wallet_addEthereumChain`; null where no public one is listed. */
  rpcUrl: string | null;
}

const PROBE_HASH = `0x${'0'.repeat(64)}`;

/** The origin of an explorer, from its transaction URL (`<origin>/tx/<hash>`). */
function explorerOrigin(txUrl: string | null): string | null {
  if (!txUrl) return null;
  const at = txUrl.indexOf('/tx/');
  return at > 0 ? txUrl.slice(0, at) : null;
}

export function p2pChainInfo(
  network: P2pNetworkId,
  tier: StellarNetwork,
): P2pChainInfo {
  const nativeSymbol = CROSS_CHAIN_NETWORKS[network].nativeSymbol;
  if (tier === 'testnet') {
    const sandbox = SANDBOX_NETWORKS[network];
    return {
      nativeSymbol,
      explorerUrl:
        sandbox.kind === 'evm' ? explorerOrigin(sandbox.explorerTx) : null,
      rpcUrl: P2P_NETWORKS[network].tiers.testnet?.defaultRpcUrl ?? null,
    };
  }
  return {
    nativeSymbol,
    // The explorers the payment receipts link (`payment-explorers.ts`).
    explorerUrl: explorerOrigin(
      paymentExplorerTxUrl(network, 'public', PROBE_HASH),
    ),
    rpcUrl: network === 'monad' ? DEFAULT_MONAD_RPC.public : null,
  };
}
