import { addressOfSecretKey } from '@/evm/evm-transaction';
import { hexToBytes } from '@/evm/rlp';
import type { PaymentNetwork } from '@/payment-intents/payment-networks';
import {
  arg,
  readSecrets,
  scriptLedgers,
  settledNetworks,
  testnetRpc,
} from '@/sandbox-settlement/sandbox-script-support';

/**
 * What the sandbox's addresses hold on every test network it settles on: the
 * treasury's gas coin and test stablecoin there (each network's own treasury
 * address: one EVM address for every EVM network, one derived key per other
 * network), and the cUSD deployer's gas. Reads only; prints addresses and
 * balances, never a secret. Run it to see what still needs funding.
 *
 *   npm run sandbox:status -- --secrets-file C:/Users/<you>/.cosmos-sandbox-secrets/sandbox.json \
 *     [--cusd bsc=0x...,gnosis=0x...]
 */
async function main(): Promise<void> {
  const secrets = readSecrets(arg('secrets-file'));
  const deployer = addressOfSecretKey(hexToBytes(secrets.deployerPrivateKey));
  const cusd = Object.fromEntries(
    (arg('cusd') ?? '')
      .split(',')
      .filter(Boolean)
      .map((pair) => pair.split('=') as [string, string]),
  ) as Partial<Record<PaymentNetwork, string>>;
  const ledgers = scriptLedgers(secrets, cusd);
  console.log(`cUSD deployer ${deployer}`);
  for (const { id, entry } of settledNetworks()) {
    const label = `${id.padEnd(8)} ${entry.testnetName.padEnd(24)}`;
    try {
      let line = await ledgers.for(id).treasuryReport(id);
      if (entry.kind === 'evm' && entry.stablecoin.issuer === 'cusd') {
        const rpc = await testnetRpc(entry);
        const gas = BigInt(
          await rpc<string>('eth_getBalance', [deployer, 'latest']),
        );
        line += `, deployer gas ${gas} wei`;
      }
      console.log(`${label} ${line}`);
    } catch (err) {
      console.log(
        `${label} unreachable: ${
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
