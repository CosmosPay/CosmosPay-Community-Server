import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '@/common/errors/api-error';
import type { AppConfig } from '@/config/configuration';
import {
  atRestKeyId,
  isSealedAtRest,
  openAtRest,
  parseAtRestKey,
  sealAtRest,
  type AtRestKey,
} from '@/wallet-auth/backup-cipher';

/** What a sealed P2P value is: the field it fills, bound to the row it belongs to. */
export type P2pSealedField =
  | 'payment-method.details'
  | 'payment-method.holder'
  | 'order.payer'
  | 'order.beneficiary';

/**
 * Encryption at rest for the personal data the P2P market keeps: a payment
 * method's account details and holder name, a payer's identity, a payout
 * beneficiary's account. The same seal as the wallet backups
 * (`backup-cipher.ts`: AES-256-GCM, a fresh IV per write, `enc1:<keyId>:…`),
 * under its own key (`P2P_DATA_ENCRYPTION_KEY`, which the boot refuses to share
 * with any other secret), with `p2p:<field>` and the row's id as associated
 * data: a value copied to another row or another field no longer opens.
 */
@Injectable()
export class P2pDataCipher {
  private key?: AtRestKey;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private current(): AtRestKey {
    if (this.key) return this.key;
    const raw = this.config.get('p2p', { infer: true }).dataEncryptionKey;
    const key = raw ? parseAtRestKey(raw) : null;
    if (!key) {
      throw ApiError.misconfigured(
        'The P2P market cannot store payment details on this deployment right now.',
        'P2P_DATA_ENCRYPTION_KEY is not set.',
      );
    }
    this.key = { id: atRestKeyId(key), key };
    return this.key;
  }

  seal(field: P2pSealedField, rowId: string, value: unknown): string {
    return sealAtRest(
      JSON.stringify(value),
      `p2p:${field}`,
      rowId,
      this.current(),
    );
  }

  open<T>(field: P2pSealedField, rowId: string, stored: string): T {
    // Every P2P value is written sealed: a plain one is not ours to trust.
    if (!isSealedAtRest(stored))
      throw new Error(`${field} of ${rowId} is not sealed`);
    return JSON.parse(
      openAtRest(stored, `p2p:${field}`, rowId, {
        current: this.current(),
        previous: [],
      }),
    ) as T;
  }
}
