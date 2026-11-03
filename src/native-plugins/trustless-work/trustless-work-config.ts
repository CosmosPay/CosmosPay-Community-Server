import { Keypair, StrKey } from '@stellar/stellar-sdk';
import type {
  AppConfig,
  StellarNetwork,
  TrustlessWorkNetworkConfig,
} from '@/config/configuration';

/** The suffix each network's variables carry. */
export const TRUSTLESS_WORK_ENV_SUFFIX: Record<StellarNetwork, string> = {
  testnet: 'TESTNET',
  public: 'MAINNET',
};

/** `TRUSTLESS_WORK_<name>_TESTNET`, `..._MAINNET`. */
export function trustlessWorkEnvName(
  network: StellarNetwork,
  name: string,
): string {
  return `TRUSTLESS_WORK_${name}_${TRUSTLESS_WORK_ENV_SUFFIX[network]}`;
}

const WASM_HASH_RE = /^[0-9a-f]{64}$/;

/** The public key of a secret seed, or null when it is not one. */
export function publicKeyOf(secret: string): string | null {
  if (!StrKey.isValidEd25519SecretSeed(secret)) return null;
  return Keypair.fromSecret(secret).publicKey();
}

/**
 * Refuses to boot the `trustless-work` plugin with keys that cannot be what
 * they claim to be, or that would break the separation of roles the contract
 * relies on. Per network:
 *
 *  - an API key and a platform secret come together: every protected payment
 *    deploys with the platform key, so one without the other serves nothing;
 *  - the secrets parse as Stellar secret seeds, the ops resolver as an account,
 *    the deployer pin as a contract and the wasm pin as 32 bytes of hex;
 *  - the platform account, the automatic resolver and the ops resolver are three
 *    different accounts. The contract refuses a dispute opened by the resolver,
 *    and the platform opens disputes, so one key holding both roles would make
 *    every auto-policy dispute fail; and an ops resolver equal to a server key
 *    would put a manual review back in the server's hands.
 *
 * Run when the plugin boots (like BlindPay's `assertBlindpayInstancesConsistent`),
 * so a deployment that does not enable it is never held to variables it does
 * not read.
 */
export function assertTrustlessWorkConfigConsistent(
  config: AppConfig['trustlessWork'],
): void {
  for (const network of ['testnet', 'public'] as const) {
    assertNetwork(network, config.networks[network]);
  }
}

function assertNetwork(
  network: StellarNetwork,
  cfg: TrustlessWorkNetworkConfig,
): void {
  const name = (key: string) => trustlessWorkEnvName(network, key);

  if (cfg.apiKey !== '' && cfg.platformSecret === '') {
    throw new Error(
      `${name('PLATFORM_SECRET')} is required when ${name('API_KEY')} is set: ` +
        'every protected payment is deployed and paid for by the platform account.',
    );
  }
  if (cfg.platformSecret !== '' && cfg.apiKey === '') {
    throw new Error(
      `${name('API_KEY')} is required when ${name('PLATFORM_SECRET')} is set: ` +
        'the platform key signs only what Trustless Work builds.',
    );
  }

  const platform = secretOrNull(cfg.platformSecret, name('PLATFORM_SECRET'));
  const resolver = secretOrNull(cfg.resolverSecret, name('RESOLVER_SECRET'));
  if (
    cfg.opsResolver !== '' &&
    !StrKey.isValidEd25519PublicKey(cfg.opsResolver)
  ) {
    throw new Error(
      `${name('OPS_RESOLVER')} must be a Stellar account address (G...): ops ` +
        'signs its resolutions in a wallet, so only the address is configured here.',
    );
  }
  if (
    cfg.deployerContract !== '' &&
    !StrKey.isValidContract(cfg.deployerContract)
  ) {
    throw new Error(
      `${name('DEPLOYER_CONTRACT')} must be a contract address (C...).`,
    );
  }
  if (cfg.contractWasmHash !== '' && !WASM_HASH_RE.test(cfg.contractWasmHash)) {
    throw new Error(
      `${name('CONTRACT_WASM_HASH')} must be the contract wasm hash, 64 hex characters.`,
    );
  }

  const accounts: [string, string | null][] = [
    [name('PLATFORM_SECRET'), platform],
    [name('RESOLVER_SECRET'), resolver],
    [name('OPS_RESOLVER'), cfg.opsResolver || null],
  ];
  for (let i = 0; i < accounts.length; i++) {
    for (let j = i + 1; j < accounts.length; j++) {
      const [a, keyA] = accounts[i];
      const [b, keyB] = accounts[j];
      if (keyA && keyB && keyA === keyB) {
        throw new Error(
          `${a} and ${b} are the same account (${keyA}). The platform, the ` +
            'automatic resolver and the ops resolver must be three different ' +
            'accounts: the contract never lets a dispute resolver open a dispute, ' +
            'and each role is a separate key to lose.',
        );
      }
    }
  }
}

function secretOrNull(secret: string, variable: string): string | null {
  if (secret === '') return null;
  const key = publicKeyOf(secret);
  if (!key) {
    throw new Error(`${variable} must be a Stellar secret seed (S...).`);
  }
  return key;
}
