import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@/config/configuration';
import {
  BACKUP_AT_REST_IV_BYTES,
  BACKUP_AT_REST_KEY_BYTES,
  BACKUP_AT_REST_PREFIX,
} from '@/wallet-auth/wallet-auth.constants';

/**
 * Encryption AT REST for the wallet backups this service keeps.
 *
 * A box is already sealed on the device under the person's password — this service
 * cannot open it, and that does not change. What this adds is the second half of
 * "a stolen database is not a stolen backup": every box is sealed again, here, under
 * a key that lives in the deployment's configuration and never in the database. A
 * dump, a replica, a backup file or a leaked snapshot then holds ciphertext of
 * ciphertext, and the offline password guessing the device-side seal invites cannot
 * even start without also stealing the key.
 *
 * AES-256-GCM, a fresh 12-byte IV per write, and the row's own `chain:address` as
 * associated data: a box moved to another row by someone with write access to the
 * table no longer opens, rather than restoring to the wrong account.
 *
 * Stored as `enc1:<keyId>:<iv>:<ciphertext+tag>` (base64url). `keyId` is the first
 * 8 hex of the key's SHA-256, so a rotation can keep old keys for reading while every
 * new write uses the current one. A value without the prefix is a row written before
 * this existed; it is read as-is and re-sealed by `npm run backups:reencrypt`.
 */

export interface AtRestKey {
  id: string;
  key: Buffer;
}

export interface BackupKeyring {
  /** Seals every write. Null only where no wallet sign-in is served (boot enforces it). */
  current: AtRestKey | null;
  /** Retired keys, kept to READ rows written before a rotation. */
  previous: AtRestKey[];
}

/** A 32-byte key from its base64 (44 chars) or hex (64 chars) spelling, or null. */
export function parseAtRestKey(raw: string): Buffer | null {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) {
    const bytes = Buffer.from(
      value.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    );
    return bytes.length === BACKUP_AT_REST_KEY_BYTES ? bytes : null;
  }
  return null;
}

export function atRestKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/**
 * The keyring from its two variables: the current key, and a comma-separated list of
 * previous ones. Throws on a malformed entry — a key that silently failed to parse
 * would be a backup that silently stops opening.
 */
export function keyringFrom(current: string, previous: string): BackupKeyring {
  const toKey = (raw: string, name: string): AtRestKey => {
    const key = parseAtRestKey(raw);
    if (!key) {
      throw new Error(
        `${name} must be ${BACKUP_AT_REST_KEY_BYTES} bytes, in base64 or hex (openssl rand -base64 32).`,
      );
    }
    return { id: atRestKeyId(key), key };
  };
  return {
    current: current.trim()
      ? toKey(current, 'WALLET_BACKUP_ENCRYPTION_KEY')
      : null,
    previous: previous
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((raw) => toKey(raw, 'WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS')),
  };
}

export function isSealedAtRest(stored: string): boolean {
  return stored.startsWith(`${BACKUP_AT_REST_PREFIX}:`);
}

const aadOf = (chain: string, address: string) =>
  Buffer.from(`${chain}:${address}`, 'utf8');

export function sealAtRest(
  box: string,
  chain: string,
  address: string,
  key: AtRestKey,
): string {
  const iv = randomBytes(BACKUP_AT_REST_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.key, iv);
  cipher.setAAD(aadOf(chain, address));
  const body = Buffer.concat([
    cipher.update(box, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return [
    BACKUP_AT_REST_PREFIX,
    key.id,
    iv.toString('base64url'),
    body.toString('base64url'),
  ].join(':');
}

/** The stored box as the device sealed it. Throws when no key opens it. */
export function openAtRest(
  stored: string,
  chain: string,
  address: string,
  keyring: BackupKeyring,
): string {
  if (!isSealedAtRest(stored)) return stored;
  const [, id, ivText, bodyText] = stored.split(':');
  const key = [keyring.current, ...keyring.previous].find((k) => k?.id === id);
  if (!key) throw new Error(`no configured key with id ${id}`);
  const body = Buffer.from(bodyText ?? '', 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key.key,
    Buffer.from(ivText ?? '', 'base64url'),
  );
  decipher.setAAD(aadOf(chain, address));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([
    decipher.update(body.subarray(0, body.length - 16)),
    decipher.final(),
  ]).toString('utf8');
}

/** The at-rest seal, with the deployment's keyring. */
@Injectable()
export class BackupCipher {
  private readonly logger = new Logger(BackupCipher.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private get keyring(): BackupKeyring {
    return this.config.get('walletAuth', { infer: true }).backupKeyring;
  }

  /** Seal a box for its row. Refuses rather than writing plaintext. */
  seal(box: string, chain: string, address: string): string {
    const key = this.keyring.current;
    if (!key) {
      throw new Error(
        'WALLET_BACKUP_ENCRYPTION_KEY is not set, so no backup can be stored.',
      );
    }
    return sealAtRest(box, chain, address, key);
  }

  /**
   * The box as the device sealed it, or null when no configured key opens it — a
   * key dropped from the ring too early, or a row tampered with. Logged, and left
   * out of the sign-in rather than failing it: the person's other wallets still
   * come back.
   */
  open(stored: string, chain: string, address: string): string | null {
    try {
      return openAtRest(stored, chain, address, this.keyring);
    } catch (error) {
      this.logger.error(
        `wallet backup for ${chain}:${address} could not be opened at rest: ${String(error)}`,
      );
      return null;
    }
  }
}
