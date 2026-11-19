import type { StellarNetwork } from '@/config/configuration';
import { isEvmAddressValue, isRpcUrl } from '@/config/sandbox-env';
import {
  isP2pNetworkId,
  P2P_NETWORKS,
  type P2pNetworkId,
} from '@/p2p/p2p-networks';
import { parseAtRestKey } from '@/wallet-auth/backup-cipher';

/**
 * The environment of the P2P market (`src/p2p/`), one set per network tier.
 *
 * `testnet` reads `P2P_*_TESTNET` and `public` reads `P2P_*_MAINNET`. A tier
 * with no `P2P_MARKET_CONTRACTS_*` has the market off: the boot needs none of
 * it, and the routes answer `network_unsupported` there. A tier with contracts
 * must have the rest of its set, checked at boot by
 * {@link assertP2pConfigConsistent}: a deployment without its start block is
 * an indexer that reads from genesis, and a mainnet network without a node of
 * the operator's choosing is a market reading from whoever answers a public URL.
 */

/** The variables of one tier, by role. */
export const P2P_TIER_ENV: Record<
  StellarNetwork,
  { contracts: string; deployBlocks: string; rpcUrls: string }
> = {
  public: {
    contracts: 'P2P_MARKET_CONTRACTS_MAINNET',
    deployBlocks: 'P2P_MARKET_DEPLOY_BLOCKS_MAINNET',
    rpcUrls: 'P2P_RPC_URLS_MAINNET',
  },
  testnet: {
    contracts: 'P2P_MARKET_CONTRACTS_TESTNET',
    deployBlocks: 'P2P_MARKET_DEPLOY_BLOCKS_TESTNET',
    rpcUrls: 'P2P_RPC_URLS_TESTNET',
  },
};

/** The one EVM key the server signs P2P transactions with (gas and matcher authority only). */
export const P2P_MATCHER_KEY_ENV = 'P2P_MATCHER_PRIVATE_KEY';
/** The key that seals payment details at rest. */
export const P2P_DATA_KEY_ENV = 'P2P_DATA_ENCRYPTION_KEY';

const EVM_SECRET_RE = /^(0x)?[0-9a-fA-F]{64}$/;

type Env = Record<string, unknown>;

function read(env: Env, name: string): string {
  const v = env[name];
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * A JSON object keyed by P2P network id (`{"base":"0x…"}`). Empty or unset is
 * `{}`. Anything else that is not such an object, a key that is no network, or
 * a value `valid` refuses, refuses the boot naming the variable: a typo
 * silently dropped is a network silently off, or worse, half on.
 */
export function parseP2pNetworkJson<T>(
  raw: string | undefined,
  variable: string,
  valid: (value: unknown) => value is T,
): Partial<Record<P2pNetworkId, T>> {
  const text = (raw ?? '').trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${variable} must be a JSON object keyed by network id`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${variable} must be a JSON object keyed by network id`);
  }
  const map: Partial<Record<P2pNetworkId, T>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isP2pNetworkId(key)) {
      throw new Error(`${variable}: "${key}" is not a P2P network id`);
    }
    if (!valid(value)) {
      throw new Error(`${variable}: the value for ${key} is not valid`);
    }
    map[key] = value;
  }
  return map;
}

export const isContractValue = (v: unknown): v is string =>
  typeof v === 'string' && isEvmAddressValue(v);
export const isBlockValue = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export const isRpcUrlValue = (v: unknown): v is string =>
  typeof v === 'string' && isRpcUrl(v);

/** One tier's parsed set. */
export interface P2pTierEnv {
  contracts: Partial<Record<P2pNetworkId, string>>;
  deployBlocks: Partial<Record<P2pNetworkId, number>>;
  rpcUrls: Partial<Record<P2pNetworkId, string>>;
}

export function readP2pTierEnv(env: Env, tier: StellarNetwork): P2pTierEnv {
  const names = P2P_TIER_ENV[tier];
  return {
    contracts: parseP2pNetworkJson(
      read(env, names.contracts),
      names.contracts,
      isContractValue,
    ),
    deployBlocks: parseP2pNetworkJson(
      read(env, names.deployBlocks),
      names.deployBlocks,
      isBlockValue,
    ),
    rpcUrls: parseP2pNetworkJson(
      read(env, names.rpcUrls),
      names.rpcUrls,
      isRpcUrlValue,
    ),
  };
}

const hexKey = (v: string) => v.toLowerCase().replace(/^0x/, '');

/**
 * Refuses to boot with a half-configured P2P tier, or with a matcher key that
 * is also another key of this service. Reads the RAW environment, like
 * `zk-payments-env.ts`: the rules are about how the variables relate.
 */
export function assertP2pConfigConsistent(env: Env): void {
  const matcher = read(env, P2P_MATCHER_KEY_ENV);
  if (matcher && !EVM_SECRET_RE.test(matcher)) {
    throw new Error(
      `${P2P_MATCHER_KEY_ENV} must be a 32-byte hex secret key (0x + 64 hex).`,
    );
  }
  if (matcher && /^(0x)?0+$/.test(matcher)) {
    throw new Error(`${P2P_MATCHER_KEY_ENV} must not be zero.`);
  }
  // The matcher holds gas money and the authority to open orders on balances
  // that authorised it. The relayer and the sandbox treasury each have one
  // other job; a key shared with either is one leak that breaks two models.
  for (const other of [
    'MONAD_RELAYER_PRIVATE_KEY',
    'SANDBOX_TREASURY_PRIVATE_KEY',
  ]) {
    const value = read(env, other);
    if (matcher && value && hexKey(value) === hexKey(matcher)) {
      throw new Error(
        `${P2P_MATCHER_KEY_ENV} must not be ${other}: the P2P matcher and that key are separate keys.`,
      );
    }
  }

  const dataKey = read(env, P2P_DATA_KEY_ENV);
  if (dataKey && !parseAtRestKey(dataKey)) {
    throw new Error(
      `${P2P_DATA_KEY_ENV} must be 32 bytes, in base64 or hex (openssl rand -base64 32).`,
    );
  }

  for (const tier of ['testnet', 'public'] as const) {
    assertTier(env, tier, Boolean(matcher), Boolean(dataKey));
  }
}

function assertTier(
  env: Env,
  tier: StellarNetwork,
  hasMatcher: boolean,
  hasDataKey: boolean,
): void {
  const names = P2P_TIER_ENV[tier];
  const set = readP2pTierEnv(env, tier);
  const networks = Object.keys(set.contracts) as P2pNetworkId[];

  for (const [variable, map] of [
    [names.deployBlocks, set.deployBlocks],
    [names.rpcUrls, set.rpcUrls],
  ] as const) {
    for (const id of Object.keys(map)) {
      if (!(id in set.contracts)) {
        throw new Error(
          `${variable} names ${id}, which has no contract in ${names.contracts}.`,
        );
      }
    }
  }
  if (networks.length === 0) return;

  const missing: string[] = [];
  if (!hasMatcher) missing.push(P2P_MATCHER_KEY_ENV);
  if (!hasDataKey) missing.push(P2P_DATA_KEY_ENV);
  if (missing.length > 0) {
    throw new Error(
      `The P2P market on ${tier} is half-configured: ${names.contracts} is set but ` +
        `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not. ` +
        'Set the whole set or none of it.',
    );
  }

  for (const id of networks) {
    const entry = P2P_NETWORKS[id].tiers[tier];
    if (!entry) {
      throw new Error(
        `${names.contracts} names ${id}, which the P2P market does not run on ${tier}.`,
      );
    }
    if (set.deployBlocks[id] === undefined) {
      throw new Error(
        `${names.deployBlocks} has no block for ${id}: the indexer would read the whole chain.`,
      );
    }
    if (!set.rpcUrls[id] && !entry.defaultRpcUrl) {
      throw new Error(
        `${names.rpcUrls} has no node for ${id}: a mainnet network needs the operator's own.`,
      );
    }
  }
}
