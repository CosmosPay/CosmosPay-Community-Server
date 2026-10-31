import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { EasyRecoveryStatus } from '@generated/prisma/client';
import {
  EASY_RECOVERY_MAX_ATTEMPTS,
  EASY_RECOVERY_RECEIVER_KEY_BYTES,
  EASY_RECOVERY_RECEIVER_KEY_CHARS,
  EASY_RECOVERY_SESSION_ID_BYTES,
  EASY_RECOVERY_SESSION_ID_CHARS,
} from '@/easy-recovery/easy-recovery.constants';

/*
 * The rules easy recovery decides with, as plain functions a spec can call
 * without a Nest container. Nothing here touches the database.
 */

/** What `GET …/sessions/{id}` answers, by stored status. Lowercase on the wire. */
export const EASY_RECOVERY_WIRE_STATUS = {
  [EasyRecoveryStatus.OPEN]: 'open',
  [EasyRecoveryStatus.OFFERED]: 'offered',
  [EasyRecoveryStatus.CLAIMED]: 'claimed',
} as const satisfies Record<EasyRecoveryStatus, string>;

export type EasyRecoveryWireStatus =
  (typeof EASY_RECOVERY_WIRE_STATUS)[EasyRecoveryStatus];

const SESSION_ID_SHAPE = new RegExp(
  `^[A-Za-z0-9_-]{${EASY_RECOVERY_SESSION_ID_CHARS}}$`,
);

/** A fresh session id: 16 bytes from the CSPRNG, base64url (22 characters). */
export function newSessionId(): string {
  return randomBytes(EASY_RECOVERY_SESSION_ID_BYTES).toString('base64url');
}

/**
 * Whether `id` could be one this service minted. Anything else is answered as
 * the 404 of an unknown session without reading the table.
 */
export function isSessionId(id: string): boolean {
  return SESSION_ID_SHAPE.test(id);
}

/**
 * Whether `value` is an X25519 public key the new device could really hold:
 * base64url without padding, 43 characters, spelled canonically (the two spare
 * bits of the last character zero, so one key has exactly one spelling), 32
 * bytes, and not one of the low-order points.
 *
 * The low-order check is what keeps "this service cannot open what it stores"
 * true. Sealing to a low-order point gives a shared secret anyone can compute —
 * this service and whoever reads its table included — so a wallet that sealed to
 * one (a bug, or a page that crafted the QR) would be parking a readable secret
 * here. The old device must refuse such a key too; this is the second fence.
 * noble rejects those points before it runs the ladder, and the throwaway scalar
 * is discarded with the result.
 */
export function isReceiverKey(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length !== EASY_RECOVERY_RECEIVER_KEY_CHARS
  ) {
    return false;
  }
  const bytes = Buffer.from(value, 'base64url');
  if (
    bytes.length !== EASY_RECOVERY_RECEIVER_KEY_BYTES ||
    bytes.toString('base64url') !== value
  ) {
    return false;
  }
  try {
    x25519.getSharedSecret(x25519.utils.randomSecretKey(), bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * What is stored instead of the code: SHA-256 hex of `{id}:{code}`.
 *
 * Salted by the session id so one table read does not answer every session's
 * code with a single lookup table. The code space is 100,000, so the hash is no
 * real secret against someone holding the row — the attempt limit is the
 * protection, and the row's hash is wiped the moment it is claimed.
 */
export function easyRecoveryCodeHash(id: string, code: string): string {
  return createHash('sha256').update(`${id}:${code}`, 'utf8').digest('hex');
}

/** Constant-time comparison of a submitted code against the stored hash. */
export function easyRecoveryCodeMatches(
  id: string,
  code: string,
  storedHash: string | null,
): boolean {
  if (!storedHash) return false;
  const submitted = Buffer.from(easyRecoveryCodeHash(id, code), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  // Both are SHA-256 digests; a length mismatch is a corrupted row, never a match.
  return (
    submitted.length === stored.length && timingSafeEqual(submitted, stored)
  );
}

/** The fields a liveness decision reads. */
export interface EasyRecoveryLiveness {
  expiresAt: Date;
  attempts: number;
}

/**
 * Whether a session still answers at all.
 *
 * Past `expiresAt` it is the 404 of a session that never existed, whether or not
 * the sweeper got to it yet. A row at the attempt limit is one whose burning
 * request has not deleted it yet (or died before it could): it is as gone as a
 * deleted one, and must not serve a status, an offer or a claim in between.
 */
export function isLiveSession<T extends EasyRecoveryLiveness>(
  row: T | null,
  now: Date,
): row is T {
  return (
    row !== null &&
    row.expiresAt.getTime() > now.getTime() &&
    row.attempts < EASY_RECOVERY_MAX_ATTEMPTS
  );
}
