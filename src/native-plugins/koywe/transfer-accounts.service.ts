import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { isUniqueViolation } from '@/common/prisma-errors';
import { PublicRecordTokens } from '@/common/public-record-token';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { resolveNetwork } from '@/common/stellar-network';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { prefixOf } from '@/native-plugins/koywe/koywe-config';
import { KoyweVirtualAccounts } from '@/native-plugins/koywe/koywe-virtual-accounts.service';
import {
  KoyweClient,
  type KoyweRecord,
} from '@/native-plugins/koywe/koywe.client';
import {
  KOYWE_KYB_LANGUAGE,
  KOYWE_MERCHANT_COUNTRY,
  KOYWE_PROVIDER,
  KOYWE_TAX_ID_TYPES,
  TRANSFER_ACCOUNT_LINK_REFRESH_MS,
  type TransferAccountStatus,
  type TransferAccountType,
} from '@/native-plugins/koywe/koywe.constants';
import {
  accountReason,
  accountStatusOf,
  merchantSlug,
  parseTaxId,
  toTransferAccount,
  type TransferAccountView,
} from '@/native-plugins/koywe/transfer-account';
import { PrismaService } from '@/prisma/prisma.service';

/** What opening an account takes, once its fields passed the DTO. */
export interface TransferAccountInput {
  type: TransferAccountType;
  name: string;
  taxId: string;
  email: string;
  phone?: string;
  address: string;
  city?: string;
  postalCode?: string;
  dateOfBirth?: string;
}

/** The columns every use of an account loads. */
const ACCOUNT_SELECT = {
  id: true,
  network: true,
  type: true,
  name: true,
  status: true,
  reason: true,
  verificationUrl: true,
  providerMerchantId: true,
  kybId: true,
  kybCheckedAt: true,
  alias: true,
  cvu: true,
  bank: true,
  updatedAt: true,
} as const;

/** An account as {@link ACCOUNT_SELECT} loads it. */
export interface AccountRow {
  id: string;
  network: string;
  type: string;
  name: string;
  status: string;
  reason: string | null;
  verificationUrl: string | null;
  providerMerchantId: string | null;
  kybId: string | null;
  kybCheckedAt: Date | null;
  alias: string | null;
  cvu: string | null;
  bank: string | null;
  updatedAt: Date;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

const UNAVAILABLE =
  'Bank transfer accounts cannot be opened right now: retry shortly.';

/**
 * Sellers' bank transfer accounts: each one a provider merchant of its own
 * under Cosmos Pay's organization, verified by the provider's KYB (a form the
 * provider hosts: this service never sees the documents), with an ARS virtual
 * account in the seller's name that payers transfer to. One per consumer and
 * network: a production key opens it on the provider's production, a sandbox
 * key on its sandbox.
 *
 * Only ids, the status, the name, the type and three digits of the tax id are
 * kept; the full tax id, the address and the contact go to the provider in
 * the creation call and nowhere else (never a log). The shared public key is
 * every anonymous wallet at once, so it can hold none (`403 account_required`).
 */
@Injectable()
export class TransferAccountsService {
  private readonly logger = new Logger(TransferAccountsService.name);
  private readonly countryIds = new Map<StellarNetwork, string>();

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly recordTokens: PublicRecordTokens,
    private readonly client: KoyweClient,
    private readonly virtualAccounts: KoyweVirtualAccounts,
  ) {}

  /**
   * The caller's account on the key's network (`status: none` without one).
   * A verification link the provider had not made yet is asked for again, at
   * most every 30 seconds per account.
   */
  async view(consumer: GatewayConsumer): Promise<TransferAccountView> {
    this.refuseSharedKey(consumer);
    const network = resolveNetwork(this.config, consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    let row = await this.prisma.bankTransferAccount.findUnique({
      where: { consumerId_network: { consumerId, network } },
      select: ACCOUNT_SELECT,
    });
    if (row && this.linkDue(row)) {
      row =
        (await this.refreshKyb(row).catch((error: unknown) => {
          this.logger.warn(
            `${KOYWE_PROVIDER} (${network}) KYB of account ${row!.id} could not be read: ${describe(error)}`,
          );
          return null;
        })) ?? row;
    }
    return toTransferAccount(row);
  }

  /**
   * Opens the caller's account: a provider merchant in the seller's name
   * (taxIdType CUIL for a person, CUIT for a company) and its KYB, whose hosted
   * form the answer links to. `409 account_exists` when one exists and was not
   * rejected; a rejected one submits its KYB again. `400 invalid_tax_id` for a
   * tax id that is not a CUIT/CUIL the type can have; `503
   * transfer_unavailable` when the provider cannot be reached.
   */
  async open(
    consumer: GatewayConsumer,
    input: TransferAccountInput,
  ): Promise<TransferAccountView> {
    this.refuseSharedKey(consumer);
    const network = resolveNetwork(this.config, consumer);
    const taxId = parseTaxId(input.type, input.taxId);
    if (!taxId) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidTaxId,
        input.type === 'company'
          ? 'taxId must be a company CUIT: 11 digits starting 30, 33 or 34 whose check digit verifies'
          : 'taxId must be a CUIL or CUIT: 11 digits starting 20, 23, 24, 25, 26 or 27 whose check digit verifies',
      );
    }
    if (!this.client.isConfigured(network)) {
      this.logger.error(
        `A bank transfer account was asked for on ${network}, which has no ${KOYWE_PROVIDER} environment: set ${prefixOf(network)}API_KEY, SECRET, ORGANIZATION_ID and WEBHOOK_SECRET`,
      );
      throw ApiError.unavailable(ApiErrorCode.TransferUnavailable, UNAVAILABLE);
    }
    const consumerId = (await this.consumers.resolve(consumer)).id;
    const existing = await this.prisma.bankTransferAccount.findUnique({
      where: { consumerId_network: { consumerId, network } },
      select: ACCOUNT_SELECT,
    });
    if (existing && existing.status !== 'rejected') {
      throw this.exists(existing.status);
    }
    if (existing?.providerMerchantId) {
      return toTransferAccount(
        await this.submitKyb(existing, existing.providerMerchantId, input, {
          retry: true,
        }),
      );
    }

    let row: AccountRow;
    try {
      row = await this.prisma.bankTransferAccount.create({
        data: {
          consumerId,
          network,
          type: input.type,
          name: input.name,
          taxIdHint: taxId.hint,
          status: 'pending',
        },
        select: ACCOUNT_SELECT,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw this.exists('pending');
      throw error;
    }

    let merchantId: string;
    try {
      const merchant = await this.client.createMerchant(network, {
        countryId: await this.countryId(network),
        profile: {
          name: input.name,
          address: input.address,
          ...(input.city ? { city: input.city } : {}),
          ...(input.postalCode ? { postalCode: input.postalCode } : {}),
          taxIdType: KOYWE_TAX_ID_TYPES[input.type],
          taxIdNumber: taxId.digits,
          slug: merchantSlug(row.id),
          supportEmail: input.email,
          email: input.email,
          ...(input.phone ? { phone: input.phone } : {}),
          ...(input.type === 'person' && input.dateOfBirth
            ? {
                dateOfBirth: input.dateOfBirth,
                nationalityCountrySymbol: KOYWE_MERCHANT_COUNTRY,
              }
            : {}),
        },
      });
      const id = text(merchant.merchantId) ?? text(merchant.id);
      if (!id) throw new Error('the merchant came back without an id');
      merchantId = id;
    } catch (error) {
      // Nothing was opened: the seller may try again.
      await this.prisma.bankTransferAccount.deleteMany({
        where: { id: row.id, providerMerchantId: null },
      });
      throw this.providerFailure(network, 'open a merchant', error);
    }
    row = await this.prisma.bankTransferAccount.update({
      where: { id: row.id },
      data: { providerMerchantId: merchantId },
      select: ACCOUNT_SELECT,
    });
    this.logger.log(
      `Bank transfer account ${row.id} (${network}) opened ${KOYWE_PROVIDER} merchant ${merchantId}`,
    );
    return toTransferAccount(
      await this.submitKyb(row, merchantId, input, { retry: false }),
    );
  }

  /** The account a request owner holds on `network`, or null. */
  forOwner(ownerId: string, network: StellarNetwork) {
    return this.prisma.bankTransferAccount.findUnique({
      where: { consumerId_network: { consumerId: ownerId, network } },
      select: ACCOUNT_SELECT,
    });
  }

  /**
   * A KYB outcome the provider reported for `merchantId` on `network` (its
   * webhook, or a read back): the account takes the status, and an approved
   * one gets its ARS virtual account. An approved account stays approved: a
   * late event never moves it back.
   */
  async applyKyb(
    network: StellarNetwork,
    merchantId: string,
    status: Exclude<TransferAccountStatus, 'none'>,
    details: {
      kybId?: string | null;
      reason?: string | null;
      link?: string | null;
    } = {},
  ): Promise<void> {
    const row = await this.prisma.bankTransferAccount.findUnique({
      where: {
        network_providerMerchantId: { network, providerMerchantId: merchantId },
      },
      select: ACCOUNT_SELECT,
    });
    if (!row) {
      this.logger.warn(
        `${KOYWE_PROVIDER} (${network}) reported KYB ${status} for merchant ${merchantId}, which is no account's here: ignored`,
      );
      return;
    }
    const verifying = status === 'pending' || status === 'in_review';
    const moved = await this.prisma.bankTransferAccount.updateMany({
      where: { id: row.id, status: { not: 'approved' } },
      data: {
        status,
        reason:
          status === 'rejected' ? accountReason(details.reason ?? null) : null,
        kybCheckedAt: new Date(),
        ...(details.kybId ? { kybId: details.kybId } : {}),
        ...(verifying
          ? details.link
            ? { verificationUrl: details.link }
            : {}
          : { verificationUrl: null }),
      },
    });
    if (moved.count > 0 && row.status !== status) {
      this.logger.log(
        `Bank transfer account ${row.id} (${network}) is ${status}`,
      );
    }
    if (status === 'approved' || row.status === 'approved') {
      await this.ensureDepositAccount({ ...row, status: 'approved' });
    }
  }

  /**
   * Brings an account up to date with the provider (the sweep, for lost
   * webhooks): a KYB never submitted is submitted, a pending or in-review one
   * is read back, an approved one without its virtual account gets it.
   */
  async refresh(row: AccountRow): Promise<void> {
    if (!row.providerMerchantId) return;
    if (row.status === 'approved') {
      await this.ensureDepositAccount(row);
      return;
    }
    if (row.status !== 'pending' && row.status !== 'in_review') return;
    if (!row.kybId) {
      await this.submitKyb(row, row.providerMerchantId, null, { retry: false });
      return;
    }
    await this.refreshKyb(row);
  }

  /** Opens the approved account's ARS virtual account once, and keeps its alias and CVU. */
  async ensureDepositAccount(row: AccountRow): Promise<void> {
    if (!row.providerMerchantId || (row.alias && row.cvu)) return;
    const network = row.network as StellarNetwork;
    try {
      const account = await this.virtualAccounts.ars(
        network,
        row.providerMerchantId,
      );
      await this.prisma.bankTransferAccount.update({
        where: { id: row.id },
        data: {
          virtualAccountId: account.id,
          alias: account.alias,
          cvu: account.cvu,
          bank: account.bank,
        },
      });
      if (!account.alias || !account.cvu) {
        this.logger.error(
          `Bank transfer account ${row.id} (${network}): the ARS virtual account has no ${account.alias ? 'CVU' : 'alias'} yet; payers are not sent to it until it has both`,
        );
      }
    } catch (error) {
      // Kept approved: the sweep opens the virtual account on its next pass.
      this.logger.error(
        `Bank transfer account ${row.id} (${network}): the ARS virtual account could not be opened: ${describe(error)}`,
      );
    }
  }

  /** Reads the KYB back and applies it; answers the account as it is now. */
  private async refreshKyb(row: AccountRow): Promise<AccountRow> {
    const network = row.network as StellarNetwork;
    const kyb = await this.client.kyb(
      network,
      row.providerMerchantId!,
      row.kybId!,
    );
    await this.applyKyb(
      network,
      row.providerMerchantId!,
      accountStatusOf(text(kyb.status)),
      {
        reason: text(kyb.statusReason),
        link: text(kyb.formLink),
      },
    );
    return (
      (await this.prisma.bankTransferAccount.findUnique({
        where: { id: row.id },
        select: ACCOUNT_SELECT,
      })) ?? row
    );
  }

  /**
   * Submits the merchant's KYB (again, `retry`, after a rejection) in Spanish,
   * the contact the seller gave; a failure leaves the account pending for the
   * sweep to submit, except on a retry, which the seller is told about.
   */
  private async submitKyb(
    row: AccountRow,
    merchantId: string,
    input: TransferAccountInput | null,
    { retry }: { retry: boolean },
  ): Promise<AccountRow> {
    const network = row.network as StellarNetwork;
    let kyb: KoyweRecord;
    try {
      kyb = await this.client.triggerKyb(network, merchantId, {
        ...(retry ? { forceRetrigger: true } : {}),
        contactOverride: {
          ...(input ? { email: input.email } : {}),
          language: KOYWE_KYB_LANGUAGE,
        },
      });
    } catch (error) {
      if (retry) throw this.providerFailure(network, 'submit the KYB', error);
      this.logger.error(
        `Bank transfer account ${row.id} (${network}): the KYB could not be submitted (the sweep retries): ${describe(error)}`,
      );
      return row;
    }
    const kybId = text(kyb.id);
    const status = accountStatusOf(text(kyb.status));
    if (text(kyb.warning)) {
      this.logger.warn(
        `Bank transfer account ${row.id} (${network}): ${KOYWE_PROVIDER} accepted the KYB with a warning: ${text(kyb.warning)}`,
      );
    }
    return this.prisma.bankTransferAccount.update({
      where: { id: row.id },
      data: {
        status,
        reason:
          status === 'rejected' ? accountReason(text(kyb.statusReason)) : null,
        verificationUrl: text(kyb.formLink),
        kybCheckedAt: new Date(),
        ...(kybId ? { kybId } : {}),
      },
      select: ACCOUNT_SELECT,
    });
  }

  /** The provider's id of Argentina on `network`, read once. */
  private async countryId(network: StellarNetwork): Promise<string> {
    const known = this.countryIds.get(network);
    if (known) return known;
    const answer = await this.client.countries(network);
    const list = Array.isArray(answer)
      ? answer
      : isObject(answer) && Array.isArray(answer.data)
        ? answer.data
        : [];
    const country = list
      .filter(isObject)
      .find(
        (c) => text(c.twoLetterIso)?.toUpperCase() === KOYWE_MERCHANT_COUNTRY,
      );
    const id = country ? text(country.id) : null;
    if (!id) {
      throw new Error(`the country list has no ${KOYWE_MERCHANT_COUNTRY}`);
    }
    this.countryIds.set(network, id);
    return id;
  }

  /** Whether a read should ask the provider for the verification link it lacks. */
  private linkDue(row: AccountRow): boolean {
    return (
      (row.status === 'pending' || row.status === 'in_review') &&
      !row.verificationUrl &&
      Boolean(row.providerMerchantId && row.kybId) &&
      (!row.kybCheckedAt ||
        Date.now() - row.kybCheckedAt.getTime() >=
          TRANSFER_ACCOUNT_LINK_REFRESH_MS)
    );
  }

  private refuseSharedKey(consumer: GatewayConsumer): void {
    if (this.recordTokens.isSharedPublicKey(consumer)) {
      throw ApiError.forbidden(
        ApiErrorCode.AccountRequired,
        'Accepting bank transfers needs a Cosmos Pay account: sign in to use your own API key.',
      );
    }
  }

  private exists(status: string): ApiError {
    return ApiError.conflict(
      ApiErrorCode.AccountExists,
      `This account already has a bank transfer account (${status}): only a rejected one can be submitted again.`,
    );
  }

  /**
   * A provider failure as the seller reads it: what the provider refused in
   * the data they sent is theirs to fix (`400 validation_failed`, its reason
   * already scrubbed of names); anything else is `503 transfer_unavailable`.
   */
  private providerFailure(
    network: StellarNetwork,
    what: string,
    error: unknown,
  ): ApiError {
    this.logger.error(
      `${KOYWE_PROVIDER} (${network}) could not ${what}: ${describe(error)}`,
    );
    if (
      error instanceof ApiError &&
      error.getStatus() === Number(HttpStatus.BAD_REQUEST)
    ) {
      const body = error.getResponse() as { message?: unknown };
      return ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        typeof body.message === 'string'
          ? body.message
          : 'The account data was refused.',
      );
    }
    return ApiError.unavailable(ApiErrorCode.TransferUnavailable, UNAVAILABLE);
  }
}

/** An error, for a log line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
