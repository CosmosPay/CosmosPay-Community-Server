import {
  arg,
  readSecrets,
  scriptLedgers,
  settledNetworks,
} from '@/sandbox-settlement/sandbox-script-support';

/**
 * The treasury's one-time setup on the test networks that need one before a
 * payer can pay or a merchant be paid (a trustline for the test USDC on the
 * XRP Ledger, a token registration on NEAR). Run it once the treasury holds
 * the network's gas coin; run again, it only reports what is already in place.
 * Prints addresses and transaction ids, never a secret.
 *
 *   npm run sandbox:prepare -- --secrets-file C:/Users/<you>/.cosmos-sandbox-secrets/sandbox.json \
 *     [--network xrp]
 */
async function main(): Promise<void> {
  const secrets = readSecrets(arg('secrets-file'));
  const only = arg('network');
  const ledgers = scriptLedgers(secrets);
  const networks = settledNetworks()
    .map(({ id }) => id)
    .filter((id) => !only || id === only);
  if (only && networks.length === 0) {
    throw new Error(
      `--network ${only} is not a network the sandbox settles on`,
    );
  }
  for (const id of networks) {
    const ledger = ledgers.for(id);
    if (!ledger.prepareTreasury) continue;
    try {
      for (const line of await ledger.prepareTreasury(id)) {
        console.log(`${id.padEnd(8)} ${line}`);
      }
    } catch (err) {
      console.log(
        `${id.padEnd(8)} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    }
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
