import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { addressOfSecretKey } from '@/evm/evm-transaction';
import { bytesToHex } from '@/evm/rlp';
import {
  arg,
  assertOutsideRepo,
} from '@/sandbox-settlement/sandbox-script-support';

/**
 * Generates the sandbox's secrets and writes them to a file OUTSIDE the
 * repository, readable by the current user only; prints only the public
 * addresses (the treasury and the cUSD deployer) that need test funds.
 *
 *   npm run sandbox:keys -- --out C:/Users/<you>/.cosmos-sandbox-secrets/sandbox.json
 *
 * - `depositSeed`: the BIP-32 seed every sandbox deposit address comes from
 *   (SANDBOX_DEPOSIT_SEED). Losing it strands what payers sent to those
 *   addresses (test funds only); leaking it lets anyone move them.
 * - `treasuryPrivateKey`: pays merchants on the test networks
 *   (SANDBOX_TREASURY_PRIVATE_KEY). Holds test stablecoins and test gas.
 * - `deployerPrivateKey`: deploys cUSD where no official test USDC exists, and
 *   is its only minter. Used by `npm run sandbox:deploy-cusd` only.
 *
 * Refuses to overwrite an existing file: new keys are new addresses, and the
 * old ones may still hold funds or own deployed tokens.
 */
function main(): void {
  const out = arg('out');
  if (!out) throw new Error('--out <path outside the repository> is required');
  const path = assertOutsideRepo(out);
  if (existsSync(path)) {
    throw new Error(
      `${path} exists: refusing to replace keys that may hold funds`,
    );
  }
  const key = () => {
    for (;;) {
      const candidate = randomBytes(32);
      if (secp256k1.utils.isValidSecretKey(candidate)) return candidate;
    }
  };
  const treasury = key();
  const deployer = key();
  const secrets = {
    depositSeed: bytesToHex(randomBytes(32)),
    treasuryPrivateKey: bytesToHex(treasury),
    deployerPrivateKey: bytesToHex(deployer),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `Sandbox secrets written to ${path} (keep it outside every repository).`,
  );
  console.log(`Treasury address: ${addressOfSecretKey(treasury)}`);
  console.log(`cUSD deployer address: ${addressOfSecretKey(deployer)}`);
}

main();
