import { StrKey } from '@stellar/stellar-sdk';
import type { StellarNetwork } from '@/config/configuration';
import { DEFAULT_ZK_PAYMENTS_RPC } from '@/config/config.constants';

/**
 * The environment of ZK payments, one set of variables per network tier.
 *
 * `testnet` reads `ZK_PAYMENTS_TESTNET_*` and `public` reads
 * `ZK_PAYMENTS_MAINNET_*`. A network with no `_TOKEN` has the feature off: the
 * boot does not need any of these, and the routes answer `network_unsupported`
 * there. A network with a `_TOKEN` must have the whole set, checked at boot by
 * {@link assertZkPaymentsConfigConsistent}: half a deployment would accept a
 * payment it can never confirm (no auditor secret) or never charge for (no fee
 * account).
 */
export const ZK_PAYMENTS_ENV_PREFIX: Record<StellarNetwork, string> = {
  testnet: 'ZK_PAYMENTS_TESTNET',
  public: 'ZK_PAYMENTS_MAINNET',
};

/** The variables of one network's set, by suffix. */
export const ZK_PAYMENTS_ENV_SUFFIXES = {
  token: 'TOKEN',
  auditorRegistry: 'AUDITOR_REGISTRY',
  verifier: 'VERIFIER',
  auditorSecret: 'AUDITOR_SECRET',
  feeAccount: 'FEE_ACCOUNT',
  deployedAtLedger: 'DEPLOYED_LEDGER',
  rpcUrl: 'RPC_URL',
} as const;

type ZkEnvField = keyof typeof ZK_PAYMENTS_ENV_SUFFIXES;

/** `ZK_PAYMENTS_TESTNET_TOKEN`, … */
export function zkPaymentsEnvName(
  network: StellarNetwork,
  field: ZkEnvField,
): string {
  return `${ZK_PAYMENTS_ENV_PREFIX[network]}_${ZK_PAYMENTS_ENV_SUFFIXES[field]}`;
}

/**
 * The auditor scalar: 32 bytes of hex, not zero. It is the key every
 * confidential amount on the token decrypts under, so it is a secret of the
 * same weight as the gateway secret.
 */
const AUDITOR_SECRET_RE = /^(0x)?[0-9a-fA-F]{64}$/;

type Env = Record<string, unknown>;

function read(env: Env, name: string): string {
  const v = env[name];
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Refuses to boot with a half-configured ZK payments network, or one whose
 * values cannot be what they claim to be. Reads the RAW environment, like
 * `identity-env.ts`: the rule is about how the variables relate to each other.
 */
export function assertZkPaymentsConfigConsistent(env: Env): void {
  for (const network of ['testnet', 'public'] as const) {
    assertNetwork(env, network);
  }
}

function assertNetwork(env: Env, network: StellarNetwork): void {
  const name = (field: ZkEnvField) => zkPaymentsEnvName(network, field);
  const value = (field: ZkEnvField) => read(env, name(field));

  const required: ZkEnvField[] = [
    'token',
    'auditorRegistry',
    'verifier',
    'auditorSecret',
    'feeAccount',
    'deployedAtLedger',
  ];
  const present = required.filter((field) => value(field) !== '');
  if (present.length === 0) return;

  const missing = required.filter((field) => value(field) === '');
  if (missing.length > 0) {
    throw new Error(
      `ZK payments on ${network} are half-configured: ${missing
        .map(name)
        .join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing while ` +
        `${present.map(name).join(', ')} ${present.length === 1 ? 'is' : 'are'} set. ` +
        'Set the whole set (scripts/zk/deploy-testnet.ts prints it) or none of it.',
    );
  }

  for (const field of ['token', 'auditorRegistry', 'verifier'] as const) {
    if (!StrKey.isValidContract(value(field))) {
      throw new Error(`${name(field)} must be a contract address (C...).`);
    }
  }
  if (!StrKey.isValidEd25519PublicKey(value('feeAccount'))) {
    throw new Error(
      `${name('feeAccount')} must be a Stellar account address (G...).`,
    );
  }
  const secret = value('auditorSecret');
  if (!AUDITOR_SECRET_RE.test(secret) || /^(0x)?0+$/.test(secret)) {
    throw new Error(
      `${name('auditorSecret')} must be the auditor scalar as 64 hex characters ` +
        '(not zero), as scripts/zk/deploy-testnet.ts prints it.',
    );
  }
  const ledger = value('deployedAtLedger');
  if (!/^\d+$/.test(ledger) || Number(ledger) < 1) {
    throw new Error(
      `${name('deployedAtLedger')} must be a positive ledger sequence.`,
    );
  }

  const rpcUrl = value('rpcUrl') || DEFAULT_ZK_PAYMENTS_RPC[network];
  if (!rpcUrl) {
    throw new Error(
      `${name('rpcUrl')} is required to serve ZK payments on ${network}: ` +
        'there is no public default Soroban RPC for this network.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error(`${name('rpcUrl')} must be an http(s) URL.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${name('rpcUrl')} must be an http(s) URL.`);
  }
}
