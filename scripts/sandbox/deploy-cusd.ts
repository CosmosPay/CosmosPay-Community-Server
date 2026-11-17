import { addressOfSecretKey, signEip1559 } from '@/evm/evm-transaction';
import { SANDBOX_USD_ARTIFACT } from '@/evm/sandbox-usd.artifact';
import { hexToBytes } from '@/evm/rlp';
import {
  arg,
  evmNetwork,
  readSecrets,
  testnetRpc,
} from '@/sandbox-settlement/sandbox-script-support';
import { SANDBOX_CUSD_DECIMALS } from '@/sandbox-settlement/sandbox-settlement.constants';

/**
 * Deploys cUSD (`contracts/SandboxUsd.sol`, the committed artifact) on ONE
 * sandbox test network whose stablecoin is cUSD, minting the initial supply to
 * the sandbox treasury, and prints the `SANDBOX_CUSD_ADDRESSES` entry to set.
 *
 *   npm run sandbox:deploy-cusd -- --network bsc \
 *     --secrets-file C:/Users/<you>/.cosmos-sandbox-secrets/sandbox.json [--rpc <url>]
 *
 * Refuses a network whose sandbox stablecoin is an official test USDC, and any
 * node whose `eth_chainId` is not the test network's: it never signs for a
 * mainnet. The deployer needs test gas on that network first.
 */
const INITIAL_SUPPLY_WHOLE = 1_000_000n;

async function main(): Promise<void> {
  const { id, entry } = evmNetwork(arg('network'));
  if (entry.stablecoin.issuer !== 'cusd') {
    throw new Error(
      `${id} uses an official test USDC: cUSD is not deployed there`,
    );
  }
  const secrets = readSecrets(arg('secrets-file'));
  const rpc = await testnetRpc(entry, arg('rpc'));
  const deployerKey = hexToBytes(secrets.deployerPrivateKey);
  const deployer = addressOfSecretKey(deployerKey);
  const treasury = addressOfSecretKey(hexToBytes(secrets.treasuryPrivateKey));

  const gas = BigInt(await rpc<string>('eth_getBalance', [deployer, 'latest']));
  if (gas === 0n) {
    throw new Error(
      `The deployer ${deployer} has no gas on ${entry.testnetName}: fund it first`,
    );
  }
  const supply = INITIAL_SUPPLY_WHOLE * 10n ** BigInt(SANDBOX_CUSD_DECIMALS);
  const data =
    SANDBOX_USD_ARTIFACT.bytecode +
    treasury.toLowerCase().replace(/^0x/, '').padStart(64, '0') +
    supply.toString(16).padStart(64, '0');
  const [nonce, gasPrice] = await Promise.all([
    rpc<string>('eth_getTransactionCount', [deployer, 'pending']),
    rpc<string>('eth_gasPrice', []),
  ]);
  const estimate = BigInt(
    await rpc<string>('eth_estimateGas', [{ from: deployer, data }]),
  );
  const price = BigInt(gasPrice);
  const signed = signEip1559(
    {
      chainId: entry.chainId,
      nonce: BigInt(nonce),
      maxFeePerGas: price * 2n,
      maxPriorityFeePerGas: price,
      gasLimit: (estimate * 13n) / 10n,
      to: '0x',
      value: 0n,
      data,
    },
    deployerKey,
  );
  await rpc<string>('eth_sendRawTransaction', [signed.raw]);
  console.log(`Deploying cUSD on ${entry.testnetName}: tx ${signed.hash}`);

  for (let i = 0; i < 90; i++) {
    const receipt = await rpc<{
      status?: string;
      contractAddress?: string;
    } | null>('eth_getTransactionReceipt', [signed.hash]);
    if (receipt) {
      if (receipt.status !== '0x1' || !receipt.contractAddress) {
        throw new Error(`The deployment reverted: ${signed.hash}`);
      }
      console.log(`cUSD deployed at ${receipt.contractAddress}`);
      console.log(
        `Add to SANDBOX_CUSD_ADDRESSES: ${id}=${receipt.contractAddress}`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `No receipt yet for ${signed.hash}: check it on the explorer`,
  );
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
