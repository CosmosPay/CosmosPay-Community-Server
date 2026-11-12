import { Injectable, Logger } from '@nestjs/common';
import type { StellarNetwork } from '@/config/configuration';
import { KoyweClient } from '@/native-plugins/koywe/koywe.client';
import {
  BANK_TRANSFER_CURRENCY,
  KOYWE_PROVIDER,
} from '@/native-plugins/koywe/koywe.constants';

/** A merchant's ARS virtual account: where payers transfer to. */
export interface ArsVirtualAccount {
  id: string | null;
  alias: string | null;
  cvu: string | null;
  bank: string | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** The list `GET virtual-accounts` answers, wherever it put it. */
function listOf(answer: unknown): Record<string, unknown>[] {
  const list = Array.isArray(answer)
    ? answer
    : isObject(answer)
      ? [answer.virtualBankAccounts, answer.virtualAccounts, answer.data].find(
          Array.isArray,
        )
      : undefined;
  return (list ?? []).filter(isObject);
}

/** One account as this plugin reads it. */
export function readVirtualAccount(
  raw: Record<string, unknown>,
): ArsVirtualAccount {
  return {
    id: text(raw.id),
    alias: text(raw.alias),
    cvu: text(raw.virtualBankAccountNumber) ?? text(raw.accountNumber),
    bank: text(raw.bankName),
  };
}

/** The active ARS account among a merchant's, if any. */
export function findArsAccount(answer: unknown): ArsVirtualAccount | null {
  const ars = listOf(answer).find(
    (account) =>
      text(account.currency)?.toUpperCase() === BANK_TRANSFER_CURRENCY &&
      account.isActive !== false,
  );
  return ars ? readVirtualAccount(ars) : null;
}

/**
 * A merchant's ARS virtual account (CVU + alias), read from the provider and
 * created when the merchant has none: the provider allows one per currency, so
 * a creation that loses a race is answered by reading the list again.
 */
@Injectable()
export class KoyweVirtualAccounts {
  private readonly logger = new Logger(KoyweVirtualAccounts.name);

  constructor(private readonly client: KoyweClient) {}

  async ars(
    network: StellarNetwork,
    merchantId: string,
  ): Promise<ArsVirtualAccount> {
    const existing = findArsAccount(
      await this.client.virtualAccounts(network, merchantId),
    );
    if (existing) return existing;
    try {
      const created = await this.client.createArsVirtualAccount(
        network,
        merchantId,
      );
      this.logger.log(
        `${KOYWE_PROVIDER} (${network}) opened the ARS virtual account of merchant ${merchantId}`,
      );
      return readVirtualAccount(created);
    } catch (error) {
      // Another replica (or an operator) may have created it meanwhile.
      const again = findArsAccount(
        await this.client.virtualAccounts(network, merchantId),
      );
      if (again) return again;
      throw error;
    }
  }
}
