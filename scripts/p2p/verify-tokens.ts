import { callJsonRpc } from '@/chains/json-rpc';
import type { StellarNetwork } from '@/config/configuration';
import { P2P_NETWORK_IDS, P2P_NETWORKS } from '@/p2p/p2p-networks';
import { arg } from '@/sandbox-settlement/sandbox-script-support';

/**
 * Checks the P2P market's token table against the chains: every listed token
 * must answer `symbol()` and `decimals()` as the table says, on a node whose
 * `eth_chainId` is the network's. Run it when the table changes.
 *
 *   npm run p2p:verify-tokens -- --tier testnet
 *   npm run p2p:verify-tokens -- --tier mainnet --rpc-urls '{"base":"https://…"}'
 *
 * Test networks use the sandbox's public nodes unless `--rpc-urls` names
 * others; a mainnet network without a node in `--rpc-urls` is skipped.
 */

const SYMBOL_SELECTOR = '0x95d89b41';
const DECIMALS_SELECTOR = '0x313ce567';

function decodeString(hex: string): string {
  const body = hex.replace(/^0x/, '');
  if (body.length === 64) {
    return Buffer.from(body, 'hex').toString('utf8').replace(/\0+$/, '');
  }
  const length = parseInt(body.slice(64, 128), 16);
  return Buffer.from(body.slice(128, 128 + length * 2), 'hex').toString('utf8');
}

async function main(): Promise<void> {
  const tierArg = arg('tier') ?? 'testnet';
  if (tierArg !== 'testnet' && tierArg !== 'mainnet') {
    throw new Error('--tier must be testnet or mainnet');
  }
  const tier: StellarNetwork = tierArg === 'mainnet' ? 'public' : 'testnet';
  const urls = JSON.parse(arg('rpc-urls') ?? '{}') as Record<string, string>;
  let failures = 0;
  for (const id of P2P_NETWORK_IDS) {
    const entry = P2P_NETWORKS[id].tiers[tier];
    if (!entry || entry.tokens.length === 0) continue;
    const url = urls[id] ?? entry.defaultRpcUrl;
    if (!url) {
      console.log(`${id}: skipped (no node given)`);
      continue;
    }
    const call = <T>(method: string, params: unknown[]) =>
      callJsonRpc<T>({ provider: id, url, timeoutMs: 20_000 }, method, params);
    try {
      const chainId = Number(BigInt(await call<string>('eth_chainId', [])));
      if (chainId !== entry.chainId) {
        console.log(
          `${id}: the node serves chain ${chainId}, not ${entry.chainId}`,
        );
        failures += 1;
        continue;
      }
      for (const token of entry.tokens) {
        const [symbol, decimals] = await Promise.all([
          call<string>('eth_call', [
            { to: token.address, data: SYMBOL_SELECTOR },
            'latest',
          ]),
          call<string>('eth_call', [
            { to: token.address, data: DECIMALS_SELECTOR },
            'latest',
          ]),
        ]);
        const read = {
          symbol: decodeString(symbol),
          decimals: Number(BigInt(decimals)),
        };
        const ok = read.decimals === token.decimals;
        if (!ok) failures += 1;
        console.log(
          `${id} ${token.address}: ${read.symbol} ${read.decimals} decimals (table: ${token.symbol} ${token.decimals}) ${ok ? 'ok' : 'MISMATCH'}`,
        );
      }
    } catch (err) {
      failures += 1;
      console.log(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
