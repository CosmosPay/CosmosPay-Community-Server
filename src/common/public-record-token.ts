import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import {
  type PublicRecordKind,
  RECORD_TOKEN_KEY_LABEL,
  RECORD_TOKEN_KEY_SALT,
} from '@/common/public-record-token.constants';
import { isSharedPublicKey } from '@/common/shared-public-key';
import type { AppConfig } from '@/config/configuration';

/**
 * The key every record token is a MAC under: HKDF-SHA256 of the server secret,
 * labelled for this one use (`public-record-token v1`), so it is never the
 * secret itself and never a key derived for anything else.
 */
export function recordTokenKey(secret: string): Buffer {
  if (!secret) throw new Error('record tokens need a non-empty secret');
  return Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      RECORD_TOKEN_KEY_SALT,
      RECORD_TOKEN_KEY_LABEL,
      32,
    ),
  );
}

/** `base64url(HMAC-SHA256(key, "<kind>:<id>"))`: 43 characters. */
export function recordToken(
  key: Buffer,
  kind: PublicRecordKind,
  id: string,
): string {
  return createHmac('sha256', key).update(`${kind}:${id}`).digest('base64url');
}

/**
 * Whether `presented` is the token of `<kind>:<id>`, compared in constant time.
 * Lengths are compared first (`timingSafeEqual` needs equal lengths, and a
 * token's length is public); a missing or empty token never matches.
 */
export function recordTokenMatches(
  key: Buffer,
  kind: PublicRecordKind,
  id: string,
  presented: string | undefined,
): boolean {
  if (!presented) return false;
  const expected = Buffer.from(recordToken(key, kind, id), 'utf8');
  const given = Buffer.from(presented, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Per-record read tokens for the rows the SHARED public key creates.
 *
 * The public key is one consumer for every anonymous caller, and anyone can
 * fetch it (`GET /v1/public-key`), so scoping a read by consumer does not
 * separate one visitor from another, and a record id is not a secret. So a
 * record created with the public key comes with `publicToken`, a MAC of its
 * kind and id under a key only this service holds, and every read or action on
 * that one record through the public key must present it in `X-Record-Token`.
 * A missing or wrong token answers the same 404 as a record that does not
 * exist, so the id alone confirms nothing.
 *
 * Derived, never stored: no migration, the same create replayed with its
 * `Idempotency-Key` answers the same token, and every replica computes it alike.
 * The key comes from `APISIX_GATEWAY_SECRET`, which the boot already requires
 * (32 characters at least, no placeholder); rotating that secret invalidates
 * every token handed out, which only matters to a public page still following
 * an old record.
 *
 * Real consumers are untouched: they never get a token and never need one.
 */
@Injectable()
export class PublicRecordTokens {
  private readonly logger = new Logger(PublicRecordTokens.name);
  private readonly publicConsumer: string;
  private key?: Buffer;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    this.publicConsumer = config.get('apisix', { infer: true }).publicConsumer;
  }

  /** Whether this caller is the shared public key (the same rule as `PublicKeyGuard`). */
  isSharedPublicKey(consumer: GatewayConsumer): boolean {
    return isSharedPublicKey(consumer, this.publicConsumer);
  }

  /**
   * The record's token for a caller on the shared public key, to hand back
   * with the record it just created; undefined for anyone else.
   */
  issueFor(
    consumer: GatewayConsumer,
    kind: PublicRecordKind,
    id: string,
  ): string | undefined {
    if (!this.isSharedPublicKey(consumer)) return undefined;
    return recordToken(this.secretKey(), kind, id);
  }

  /**
   * Whether this caller may reach the record: always for a real consumer
   * (its reads stay scoped by consumer, as before); for the shared public key,
   * only with the record's token. A refusal is logged without the token.
   */
  admits(
    consumer: GatewayConsumer,
    kind: PublicRecordKind,
    id: string,
    presented: string | undefined,
  ): boolean {
    if (!this.isSharedPublicKey(consumer)) return true;
    if (recordTokenMatches(this.secretKey(), kind, id, presented)) return true;
    this.logger.warn(
      `Refused a ${kind} read by the shared public key: ` +
        `${presented ? 'wrong' : 'no'} X-Record-Token (id=${id})`,
    );
    return false;
  }

  /** `record` with its `publicToken` when the caller is the shared public key. */
  attach<T extends { id: string }>(
    consumer: GatewayConsumer,
    kind: PublicRecordKind,
    record: T,
  ): T & { publicToken?: string } {
    const publicToken = this.issueFor(consumer, kind, record.id);
    return publicToken ? { ...record, publicToken } : record;
  }

  private secretKey(): Buffer {
    this.key ??= recordTokenKey(
      this.config.get('apisix', { infer: true }).gatewaySecret,
    );
    return this.key;
  }
}
