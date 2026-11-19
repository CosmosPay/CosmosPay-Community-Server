import { existsSync, readFileSync } from 'node:fs';
import { parse as parseEnv } from 'dotenv';
import { callJsonRpc } from '@/chains/json-rpc';
import { toChecksumAddress } from '@/chains/chain-address';
import { readP2pTierEnv } from '@/config/p2p-env';
import type { StellarNetwork } from '@/config/configuration';
import { addressOfSecretKey, signEip1559 } from '@/evm/evm-transaction';
import { P2P_MARKET_ARTIFACT } from '@/evm/p2p-market.artifact';
import { hexToBytes } from '@/evm/rlp';
import {
  decodeAddress,
  decodeBool,
  decodeUint,
  p2pCalldata,
  p2pMarketInitCode,
} from '@/p2p/p2p-market-abi';
import {
  isP2pNetworkId,
  P2P_NETWORKS,
  type P2pToken,
} from '@/p2p/p2p-networks';
import { P2P_MAX_PROTOCOL_FEE_BPS } from '@/p2p/p2p.constants';
import {
  arg,
  assertOutsideRepo,
} from '@/sandbox-settlement/sandbox-script-support';

/**
 * Deploys `P2P_MARKET_ARTIFACT` (contracts/P2PMarket.sol) on ONE network and
 * tier, or verifies a deployment that exists, and prints the environment
 * entries the service reads.
 *
 *   npm run p2p:deploy -- --network base --tier testnet \
 *     --secrets-file C:/Users/<you>/.cosmos-p2p/deployer.json \
 *     --treasury 0x… --arbiter 0x… --fee-bps 50 [--owner 0x…] [--rpc <url>] \
 *     [--env-file .env] [--contract 0x…] [--i-understand-mainnet]
 *
 * The secrets file (outside every repository) is `{ "deployerPrivateKey":
 * "0x…" }`; the key is never printed. The node's `eth_chainId` must be the
 * network's on that tier before anything is signed.
 *
 *   - testnet: the deployer is the owner while it allows the listed tokens
 *     (`setToken`), then hands ownership to `--owner` when given (that wallet
 *     calls `acceptOwnership`).
 *   - mainnet: needs `--i-understand-mainnet`, `--owner` (a multisig) and
 *     `--rpc`; the owner is set at construction and the script PRINTS the
 *     `setToken` calls for the owner to send. The deployer never owns it.
 *
 * Run again, it finds the deployment (`--contract`, or the tier's
 * `P2P_MARKET_CONTRACTS_*` in `--env-file`), verifies it (runtime bytecode
 * against the artifact, the owner, each listed token allowed) and stops.
 */

const SECRET_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;

function required(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function address(name: string, value: string | undefined): string {
  if (!value || !ADDRESS_RE.test(value)) {
    throw new Error(`--${name} must be an EVM address (0x + 40 hex)`);
  }
  return toChecksumAddress(value);
}

function deployerKey(path: string): Uint8Array {
  const full = assertOutsideRepo(path);
  if (!existsSync(full)) throw new Error(`No secrets file at ${full}`);
  const parsed = JSON.parse(readFileSync(full, 'utf8')) as {
    deployerPrivateKey?: unknown;
  };
  if (
    typeof parsed.deployerPrivateKey !== 'string' ||
    !SECRET_RE.test(parsed.deployerPrivateKey)
  ) {
    throw new Error('The secrets file has no valid deployerPrivateKey');
  }
  return hexToBytes(parsed.deployerPrivateKey);
}

async function sendAndWait(
  rpc: Rpc,
  chainId: number,
  key: Uint8Array,
  tx: { to: string; data: string },
  label: string,
): Promise<{ hash: string; block: bigint; contractAddress?: string }> {
  const from = addressOfSecretKey(key);
  const [nonce, gasPrice, estimate] = await Promise.all([
    rpc<string>('eth_getTransactionCount', [from, 'pending']),
    rpc<string>('eth_gasPrice', []),
    rpc<string>('eth_estimateGas', [
      tx.to === '0x'
        ? { from, data: tx.data }
        : { from, to: tx.to, data: tx.data },
    ]),
  ]);
  const price = BigInt(gasPrice);
  const signed = signEip1559(
    {
      chainId,
      nonce: BigInt(nonce),
      maxFeePerGas: price * 2n,
      maxPriorityFeePerGas: price,
      gasLimit: (BigInt(estimate) * 13n) / 10n,
      to: tx.to,
      value: 0n,
      data: tx.data,
    },
    key,
  );
  await rpc<string>('eth_sendRawTransaction', [signed.raw]);
  console.log(`${label}: tx ${signed.hash}`);
  for (let i = 0; i < 120; i++) {
    const receipt = await rpc<{
      status?: string;
      blockNumber?: string;
      contractAddress?: string;
    } | null>('eth_getTransactionReceipt', [signed.hash]);
    if (receipt?.blockNumber) {
      if (receipt.status !== '0x1')
        throw new Error(`${label} reverted: ${signed.hash}`);
      return {
        hash: signed.hash,
        block: BigInt(receipt.blockNumber),
        contractAddress: receipt.contractAddress,
      };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`No receipt yet for ${signed.hash}: check it on an explorer`);
}

async function verify(
  rpc: Rpc,
  contract: string,
  tokens: readonly P2pToken[],
  owner: string | undefined,
): Promise<void> {
  const [code, expected, onchainOwner] = await Promise.all([
    rpc<string>('eth_getCode', [contract, 'latest']),
    rpc<string>('eth_call', [
      {
        data: p2pMarketInitCode(P2P_MARKET_ARTIFACT.bytecode, {
          owner: '0x0000000000000000000000000000000000000001',
          treasury: '0x0000000000000000000000000000000000000002',
          arbiter: '0x0000000000000000000000000000000000000003',
          feeBps: 0,
        }),
      },
      'latest',
    ]),
    rpc<string>('eth_call', [
      { to: contract, data: p2pCalldata.owner() },
      'latest',
    ]),
  ]);
  const problems: string[] = [];
  if (code === '0x' || code.toLowerCase() !== expected.toLowerCase()) {
    problems.push(`the code at ${contract} is not this build's P2PMarket`);
  }
  const currentOwner = decodeAddress(onchainOwner);
  console.log(`owner: ${currentOwner}`);
  if (owner && currentOwner !== owner) {
    problems.push(`the owner is ${currentOwner}, not ${owner}`);
  }
  for (const t of tokens) {
    const allowed = decodeBool(
      await rpc<string>('eth_call', [
        { to: contract, data: p2pCalldata.tokenAllowed(t.address) },
        'latest',
      ]),
    );
    console.log(
      `${t.symbol} ${t.address}: ${allowed ? 'allowed' : 'NOT allowed'}`,
    );
    if (!allowed) problems.push(`${t.symbol} is not allowed (setToken)`);
  }
  const fee = decodeUint(
    await rpc<string>('eth_call', [
      { to: contract, data: p2pCalldata.protocolFeeBps() },
      'latest',
    ]),
    16,
  );
  console.log(`protocol fee: ${fee} bps`);
  if (problems.length)
    throw new Error(`Deployment check failed: ${problems.join('; ')}`);
  console.log('Deployment verified.');
}

async function main(): Promise<void> {
  const networkId = required('network');
  if (!isP2pNetworkId(networkId))
    throw new Error(`${networkId} is not a P2P network id`);
  const tierArg = required('tier');
  if (tierArg !== 'testnet' && tierArg !== 'mainnet') {
    throw new Error('--tier must be testnet or mainnet');
  }
  const tier: StellarNetwork = tierArg === 'mainnet' ? 'public' : 'testnet';
  const mainnet = tier === 'public';
  if (mainnet && !process.argv.includes('--i-understand-mainnet')) {
    throw new Error('A mainnet deployment needs --i-understand-mainnet');
  }
  const entry = P2P_NETWORKS[networkId].tiers[tier];
  if (!entry)
    throw new Error(
      `The P2P market does not run on ${networkId} on ${tierArg}`,
    );
  const env = arg('env-file')
    ? parseEnv(readFileSync(required('env-file')))
    : {};
  const rpcUrl =
    arg('rpc') ??
    readP2pTierEnv(env, tier).rpcUrls[networkId] ??
    entry.defaultRpcUrl;
  if (!rpcUrl) throw new Error('--rpc <url> is required on mainnet');
  const rpc: Rpc = (method, params) =>
    callJsonRpc(
      {
        provider: P2P_NETWORKS[networkId].name,
        url: rpcUrl,
        timeoutMs: 20_000,
      },
      method,
      params,
    );
  const chainId = Number(BigInt(await rpc<string>('eth_chainId', [])));
  if (chainId !== entry.chainId) {
    throw new Error(
      `The node serves chain ${chainId}, not ${entry.chainId}: refusing`,
    );
  }

  const cusd = entry.sandboxCusd
    ? (env.SANDBOX_CUSD_ADDRESSES ?? '')
        .split(',')
        .map((e) => e.trim().split('='))
        .find(([k]) => k === networkId)?.[1]
    : undefined;
  const tokens: P2pToken[] = [
    ...entry.tokens,
    ...(cusd
      ? [{ symbol: 'cUSD', address: toChecksumAddress(cusd), decimals: 6 }]
      : []),
  ];
  const owner = arg('owner') ? address('owner', arg('owner')) : undefined;

  const existing =
    arg('contract') ?? readP2pTierEnv(env, tier).contracts[networkId];
  if (existing) {
    console.log(
      `Verifying the deployment at ${existing} on ${P2P_NETWORKS[networkId].name} (${tierArg})`,
    );
    await verify(rpc, toChecksumAddress(existing), tokens, owner);
    return;
  }

  const key = deployerKey(required('secrets-file'));
  const deployer = addressOfSecretKey(key);
  const treasury = address('treasury', arg('treasury'));
  const arbiter = address('arbiter', arg('arbiter'));
  const feeBps = Number(required('fee-bps'));
  if (
    !Number.isInteger(feeBps) ||
    feeBps < 0 ||
    feeBps > P2P_MAX_PROTOCOL_FEE_BPS
  ) {
    throw new Error(`--fee-bps must be 0 to ${P2P_MAX_PROTOCOL_FEE_BPS}`);
  }
  if (mainnet && !owner)
    throw new Error('--owner (a multisig) is required on mainnet');
  const gas = BigInt(await rpc<string>('eth_getBalance', [deployer, 'latest']));
  if (gas === 0n)
    throw new Error(`The deployer ${deployer} has no gas: fund it first`);

  const constructorOwner = mainnet ? (owner as string) : deployer;
  const deployed = await sendAndWait(
    rpc,
    chainId,
    key,
    {
      to: '0x',
      data: p2pMarketInitCode(P2P_MARKET_ARTIFACT.bytecode, {
        owner: constructorOwner,
        treasury,
        arbiter,
        feeBps,
      }),
    },
    'Deploying P2PMarket',
  );
  if (!deployed.contractAddress)
    throw new Error('The receipt names no contract address');
  const contract = toChecksumAddress(deployed.contractAddress);
  console.log(`P2PMarket deployed at ${contract} (block ${deployed.block})`);

  if (mainnet) {
    console.log(
      '\nThe owner sends these, one per token (to the contract, value 0):',
    );
    for (const t of tokens) {
      console.log(
        `  setToken ${t.symbol}: to ${contract} data ${p2pCalldata.setToken(t.address, true)}`,
      );
    }
  } else {
    for (const t of tokens) {
      await sendAndWait(
        rpc,
        chainId,
        key,
        { to: contract, data: p2pCalldata.setToken(t.address, true) },
        `Allowing ${t.symbol}`,
      );
    }
    if (owner && owner !== deployer) {
      await sendAndWait(
        rpc,
        chainId,
        key,
        { to: contract, data: p2pCalldata.transferOwnership(owner) },
        'Handing ownership over',
      );
      console.log(`${owner} must call acceptOwnership() to take it.`);
    }
  }

  const suffix = mainnet ? 'MAINNET' : 'TESTNET';
  console.log(
    '\nMerge into the environment (one JSON object per variable, all networks of the tier):',
  );
  console.log(`P2P_MARKET_CONTRACTS_${suffix}={"${networkId}":"${contract}"}`);
  console.log(
    `P2P_MARKET_DEPLOY_BLOCKS_${suffix}={"${networkId}":${deployed.block}}`,
  );
  if (mainnet)
    console.log(`P2P_RPC_URLS_${suffix}={"${networkId}":"<your node>"}`);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
