import { addressOfSecretKey } from '@/evm/evm-transaction';
import { hexToBytes } from '@/evm/rlp';
import type { PaymentNetwork } from '@/payment-intents/payment-networks';
import {
  arg,
  readSecrets,
  testnetRpc,
} from '@/sandbox-settlement/sandbox-script-support';
import { SANDBOX_NETWORKS } from '@/sandbox-settlement/sandbox-settlement.constants';

/**
 * What the sandbox's addresses hold on every EVM test network: the treasury's
 * gas and stablecoin, the cUSD deployer's gas. Reads only; prints addresses
 * and balances, never a secret. Run it to see what still needs funding.
 *
 *   npm run sandbox:status -- --secrets-file C:/Users/<you>/.cosmos-sandbox-secrets/sandbox.json \
 *     [--cusd bsc=0x...,gnosis=0x...]
 */
async function main(): Promise<void> {
  const secrets = readSecrets(arg('secrets-file'));
  const treasury = addressOfSecretKey(hexToBytes(secrets.treasuryPrivateKey));
  const deployer = addressOfSecretKey(hexToBytes(secrets.deployerPrivateKey));
  const cusd = Object.fromEntries(
    (arg('cusd') ?? '')
      .split(',')
      .filter(Boolean)
      .map((pair) => pair.split('=') as [string, string]),
  ) as Partial<Record<PaymentNetwork, string>>;
  console.log(`treasury ${treasury}  deployer ${deployer}`);
  for (const [id, entry] of Object.entries(SANDBOX_NETWORKS)) {
    if (entry.kind !== 'evm') continue;
    try {
      const rpc = await testnetRpc(entry);
      const gas = BigInt(
        await rpc<string>('eth_getBalance', [treasury, 'latest']),
      );
      const deployerGas =
        entry.stablecoin.issuer === 'cusd'
          ? BigInt(await rpc<string>('eth_getBalance', [deployer, 'latest']))
          : null;
      const token = entry.stablecoin.contract ?? cusd[id as PaymentNetwork];
      let stable = 'not deployed';
      if (token) {
        const answer = await rpc<string>('eth_call', [
          {
            to: token,
            data:
              '0x70a08231' +
              treasury.toLowerCase().replace(/^0x/, '').padStart(64, '0'),
          },
          'latest',
        ]);
        stable = `${BigInt(answer)} base units`;
      }
      console.log(
        `${id.padEnd(8)} ${entry.testnetName.padEnd(24)} treasury gas ${gas} wei, ` +
          `${entry.stablecoin.symbol} ${stable}` +
          (deployerGas === null ? '' : `, deployer gas ${deployerGas} wei`),
      );
    } catch (err) {
      console.log(
        `${id.padEnd(8)} ${entry.testnetName.padEnd(24)} unreachable: ${
          err instanceof Error ? err.message.slice(0, 80) : String(err)
        }`,
      );
    }
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
