import { Injectable, Logger } from '@nestjs/common';
import { isUniqueViolation } from '@/common/prisma-errors';
import type { StellarNetwork } from '@/config/configuration';
import type { ConversionTarget } from '@/native-plugins/koywe/bank-transfer-rail';
import { KoyweClient } from '@/native-plugins/koywe/koywe.client';
import { KOYWE_PROVIDER } from '@/native-plugins/koywe/koywe.constants';
import { PrismaService } from '@/prisma/prisma.service';

/** A conversion that cannot go on until a person acts (an approval policy hold). */
export class BankTransferOnHold extends Error {
  constructor(
    readonly reason: string,
    readonly providerStatus: string,
  ) {
    super(reason);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/**
 * The provider's CRYPTO account for a seller's address under a merchant: a
 * conversion delivers to an account id (`acc_...`), never to an address. Looked
 * up in `bank_transfer_crypto_account` first, then searched at the provider
 * (an earlier registration this table lost), then registered once. A
 * registration the approval policy holds is {@link BankTransferOnHold}.
 */
@Injectable()
export class KoyweCryptoAccounts {
  private readonly logger = new Logger(KoyweCryptoAccounts.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: KoyweClient,
  ) {}

  async accountFor(
    network: StellarNetwork,
    merchantId: string,
    target: ConversionTarget,
    address: string,
  ): Promise<string> {
    const key = {
      network,
      merchantId,
      providerNetwork: target.network,
      token: target.token,
      address: address.toLowerCase(),
    };
    const cached = await this.prisma.bankTransferCryptoAccount.findUnique({
      where: { network_merchantId_providerNetwork_token_address: key },
      select: { accountId: true },
    });
    if (cached) return cached.accountId;

    const search = await this.client.searchCryptoAccounts(network, merchantId, {
      currencySymbol: target.token,
      network: target.network,
      address,
    });
    const found = (Array.isArray(search) ? search : [])
      .filter(isObject)
      .find(
        (account) =>
          text(account.address)?.toLowerCase() === key.address &&
          text(account.id) &&
          !text(account.pendingApprovalId),
      );
    let accountId = found ? text(found.id) : null;
    if (!accountId) {
      const created = await this.client.createCryptoAccount(
        network,
        merchantId,
        {
          name: `Cosmos Pay seller ${address.slice(0, 6)}…${address.slice(-4)}`,
          kind: 'CRYPTO',
          address,
          accountNumber: address,
          routingNumber: '',
          isDefault: false,
          network: target.network,
          currencySymbol: target.token,
        },
      );
      const pending = text(created.pendingApprovalId);
      if (pending || !text(created.id)) {
        throw new BankTransferOnHold(
          `the seller's ${target.token} account on ${target.network} awaits approval (${pending ?? 'no id answered'})`,
          'ACCOUNT_ON_HOLD',
        );
      }
      accountId = text(created.id)!;
      this.logger.log(
        `${KOYWE_PROVIDER} (${network}) registered ${target.token} on ${target.network} for merchant ${merchantId}: ${accountId}`,
      );
    }
    try {
      await this.prisma.bankTransferCryptoAccount.create({
        data: { ...key, accountId },
      });
    } catch (error) {
      // Another conversion registered it at the same moment: same account.
      if (!isUniqueViolation(error)) throw error;
    }
    return accountId;
  }
}
