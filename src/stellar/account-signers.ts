import { Keypair } from '@stellar/stellar-sdk';

/**
 * Who may currently sign for a Stellar account, read from Horizon.
 *
 * ## Why anything here needs this
 *
 * Almost every signature this service checks is "by the account's key", and for
 * almost every account that is the master key, whose public key IS the address.
 * A RECOVERED account is the exception: SEP-30 recovery puts a new device key on
 * the account and takes the old master to weight 0, so the address stops being
 * able to sign for itself. Verifying against the address alone locks a recovered
 * wallet out of its own sign-in and its own backup — which is what the port of
 * the wallet sign-in from the developer platform did, because this half was left
 * behind.
 *
 * So the rule is the one SEP-10 uses: a signature counts when it comes from a
 * signer the ACCOUNT currently lists, with enough weight to reach its own
 * threshold.
 *
 * Pure except for `fetchAccountSigners`, so the spec reaches the rule itself.
 */

export interface AccountSigners {
  signers: { key: string; weight: number }[];
  /** The medium threshold, or 1 when the account publishes none (Stellar's rule). */
  medThreshold: number;
  /** The high threshold, or 1 likewise. Changing signers is a HIGH operation. */
  highThreshold: number;
}

/** Signers and thresholds from a Horizon account resource, or null for a 404. */
export async function fetchAccountSigners(
  horizonUrl: string,
  address: string,
  timeoutMs: number,
): Promise<AccountSigners | null> {
  const res = await fetch(
    `${horizonUrl.replace(/\/+$/, '')}/accounts/${encodeURIComponent(address)}`,
    {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`horizon answered ${res.status}`);
  return parseAccountSigners(await res.json());
}

/** The signer set a Horizon account body describes. Ignores anything malformed. */
export function parseAccountSigners(body: unknown): AccountSigners {
  const b = (body ?? {}) as {
    signers?: { key?: unknown; weight?: unknown; type?: unknown }[];
    thresholds?: { med_threshold?: unknown; high_threshold?: unknown };
  };
  const signers = (Array.isArray(b.signers) ? b.signers : [])
    // Only ed25519 keys can produce the signatures checked here; a hash or
    // pre-authorized-transaction signer is a different instrument.
    .filter(
      (s) =>
        typeof s.key === 'string' &&
        typeof s.weight === 'number' &&
        (s.type === undefined || s.type === 'ed25519_public_key'),
    )
    .map((s) => ({ key: s.key as string, weight: s.weight as number }));
  const threshold = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 1);
  return {
    signers,
    medThreshold: threshold(b.thresholds?.med_threshold),
    highThreshold: threshold(b.thresholds?.high_threshold),
  };
}

/**
 * Does `verify(key)` hold for some signer that can act for the account ALONE?
 *
 * A single message carries a single signature, so "enough weight" means one
 * signer whose own weight reaches the medium threshold. A recovery server's
 * half-weight signer therefore cannot speak for the owner here, which is
 * correct: those two co-sign transactions, they do not sign in.
 */
export function signedByCurrentSigner(
  account: AccountSigners,
  verifyAs: (publicKey: string) => boolean,
): boolean {
  for (const signer of account.signers) {
    if (signer.weight < account.medThreshold) continue;
    if (verifyAs(signer.key)) return true;
  }
  return false;
}

/** Is `value` a correctly checksummed account id? Never throws. */
export function isAccountId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    Keypair.fromPublicKey(value);
    return true;
  } catch {
    return false;
  }
}
