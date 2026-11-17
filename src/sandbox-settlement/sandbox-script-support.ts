import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { callJsonRpc } from '@/chains/json-rpc';
import type { PaymentNetwork } from '@/payment-intents/payment-networks';
import {
  SANDBOX_NETWORKS,
  type SandboxEvmNetwork,
} from '@/sandbox-settlement/sandbox-settlement.constants';

/**
 * What the sandbox scripts (`scripts/sandbox/`) share, kept here so they can
 * import it by alias: the secrets file (written by
 * `npm run sandbox:keys`, kept OUTSIDE the repository), argument parsing and a
 * JSON-RPC call that refuses a node on any chain but the test network's.
 */

/** The secrets file's shape. Hex values; never printed. */
export interface SandboxSecrets {
  depositSeed: string;
  treasuryPrivateKey: string;
  deployerPrivateKey: string;
}

/** `--name value` from argv; undefined when absent. */
export function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/** A path refused when it lies inside this repository: secrets never do. */
export function assertOutsideRepo(path: string): string {
  const full = resolve(path);
  const repo = resolve(__dirname, '..', '..');
  if (full === repo || full.startsWith(repo + sep)) {
    throw new Error(
      `Refusing ${full}: sandbox secrets live outside the repository`,
    );
  }
  return full;
}

export function readSecrets(path: string | undefined): SandboxSecrets {
  if (!path) throw new Error('--secrets-file <path> is required');
  const full = assertOutsideRepo(path);
  if (!existsSync(full)) throw new Error(`No secrets file at ${full}`);
  const parsed = JSON.parse(
    readFileSync(full, 'utf8'),
  ) as Partial<SandboxSecrets>;
  for (const key of [
    'depositSeed',
    'treasuryPrivateKey',
    'deployerPrivateKey',
  ] as const) {
    if (
      typeof parsed[key] !== 'string' ||
      !/^0x[0-9a-f]+$/i.test(parsed[key])
    ) {
      throw new Error(`The secrets file has no valid ${key}`);
    }
  }
  return parsed as SandboxSecrets;
}

/** The EVM test network the script runs on; anything else is refused. */
export function evmNetwork(id: string | undefined): {
  id: PaymentNetwork;
  entry: SandboxEvmNetwork;
} {
  const entry = id ? SANDBOX_NETWORKS[id as PaymentNetwork] : undefined;
  if (!entry || entry.kind !== 'evm') {
    throw new Error(
      `--network must be a sandbox EVM test network (got ${id ?? 'nothing'})`,
    );
  }
  return { id: id as PaymentNetwork, entry };
}

/**
 * A JSON-RPC client for one test network that checks `eth_chainId` first: a
 * URL pointing at a mainnet (or any other chain) stops the script before it
 * signs anything.
 */
export async function testnetRpc(
  entry: SandboxEvmNetwork,
  url = entry.defaultRpcUrl,
): Promise<<T>(method: string, params: unknown[]) => Promise<T>> {
  const target = { provider: entry.testnetName, url, timeoutMs: 30_000 };
  const chainId = Number(
    BigInt(await callJsonRpc<string>(target, 'eth_chainId', [])),
  );
  if (chainId !== entry.chainId) {
    throw new Error(
      `${url} serves chain ${chainId}, not ${entry.testnetName} (${entry.chainId}): refusing`,
    );
  }
  return <T>(method: string, params: unknown[]) =>
    callJsonRpc<T>(target, method, params);
}
