import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { isUniqueViolation } from '@/common/prisma-errors';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import {
  documentHash,
  documentHintLabel,
  parsePayerDocument,
} from '@/native-plugins/koywe/bank-transfer-document';
import {
  BankTransferRail,
  type Payee,
} from '@/native-plugins/koywe/bank-transfer-rail.service';
import {
  distinctAmount,
  effectiveTransferStatus,
  transferExpiry,
  type BankTransferStatus,
} from '@/native-plugins/koywe/bank-transfer';
import {
  KoywePooledAccount,
  type DepositInstructions,
} from '@/native-plugins/koywe/koywe-pooled-account.service';
import {
  BANK_TRANSFER_MATCH_GRACE_MS,
  KOYWE_PROVIDER,
} from '@/native-plugins/koywe/koywe.constants';
import { PaymentRequestRails } from '@/payment-request-rails/payment-request-rails';
import { PrismaService } from '@/prisma/prisma.service';

/** What the payer is answered: where to transfer, how much, until when. Never the document. */
export interface BankTransferView {
  id: string;
  status: BankTransferStatus;
  currency: string;
  amount: string;
  alias: string;
  cvu: string;
  holder: string | null;
  bank: string | null;
  documentHint: string;
  expiresAt: string;
}

/** The columns the payer's answer is built from. */
const TRANSFER_SELECT = {
  id: true,
  status: true,
  currency: true,
  instructedAmount: true,
  documentHint: true,
  expiresAt: true,
  providerMerchantId: true,
} as const;

const NOT_FOUND = 'Payment request not found';

const UNAVAILABLE =
  'Bank transfers are not available right now: retry shortly or pay with another method.';

/**
 * The payer's side of a bank transfer (`POST
 * /v1/payment-links/fiat/{id}/transfers`, keyless): the request id is the
 * capability, as on the rest of the payer's page. The payer names their
 * CUIT/CUIL or DNI and is answered the deposit instructions: the seller's
 * alias and CVU (or Cosmos Pay's, in pooled mode), the exact amount and until
 * when. The document only identifies the deposit when it arrives: it is stored
 * as an HMAC of its DNI part and three digits, never as typed.
 *
 * One transfer per request and document: asking again with the same document
 * answers the same transfer (a stale one awaiting its deposit is given a new
 * hour), so a reload never multiplies them. Every open transfer of one
 * depositor at one merchant asks a different amount (a few cents added when
 * two charges ask the same), so a deposit names exactly one of them.
 */
@Injectable()
export class BankTransfersService {
  private readonly logger = new Logger(BankTransfersService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly rails: PaymentRequestRails,
    private readonly rail: BankTransferRail,
    private readonly pooled: KoywePooledAccount,
  ) {}

  /**
   * The deposit instructions for paying request `id` by bank transfer from
   * the account of `document`'s holder; `created` when this call opened the
   * transfer. 404 for an unknown request, `409 request_closed` unless it is
   * open, `400 method_unavailable` when a bank transfer cannot pay it, `400
   * invalid_document`, `503 transfer_unavailable` when the deposit account
   * cannot be given.
   */
  async open(
    id: string,
    document: string,
  ): Promise<{ transfer: BankTransferView; created: boolean }> {
    const request = await this.rails.ledger().find(id);
    if (!request) throw ApiError.notFound(NOT_FOUND);
    if (request.status !== 'open') {
      throw ApiError.conflict(
        ApiErrorCode.RequestClosed,
        `Payment request ${id} is ${request.status}: it can no longer be paid`,
      );
    }
    const terms = {
      ownerId: request.ownerId,
      network: request.network,
      currency: request.currency,
      amount: request.amount,
      chainId: request.chainId,
      tokenAddress: request.tokenAddress,
    };
    const accepted = await this.rail.accepts(terms, {
      symbol: request.token,
      decimals: request.tokenDecimals,
    });
    const payee = accepted
      ? await this.rail.payee(request.ownerId, request.network, true)
      : null;
    if (!payee) {
      throw ApiError.badRequest(
        ApiErrorCode.MethodUnavailable,
        `Payment request ${id} cannot be paid by bank transfer`,
      );
    }
    const parsed = parsePayerDocument(document);
    if (!parsed) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidDocument,
        'document must be a CUIT/CUIL (11 digits with a valid check digit) or a DNI (7 or 8 digits)',
      );
    }
    const instructions = await this.instructions(payee, request.network);
    const hash = documentHash(
      this.config.get('koywe', { infer: true }).documentPepper,
      parsed.dniPart,
    );
    const now = new Date();
    const key = { paymentRequestId: request.id, documentHash: hash };

    const existing = await this.prisma.bankTransfer.findUnique({
      where: { paymentRequestId_documentHash: key },
      select: TRANSFER_SELECT,
    });
    if (existing) {
      return {
        transfer: this.view(
          await this.renewIfStale(
            existing,
            payee.merchantId,
            request.expiresAt,
            now,
          ),
          instructions,
        ),
        created: false,
      };
    }
    const instructedAmount = await this.instructedAmount(
      request.network,
      payee.merchantId,
      hash,
      request.amount,
      now,
    );
    try {
      const row = await this.prisma.bankTransfer.create({
        data: {
          ...key,
          network: request.network,
          providerMerchantId: payee.merchantId,
          documentHint: parsed.hint,
          currency: request.currency,
          amount: request.amount,
          instructedAmount,
          status: 'awaiting_deposit',
          expiresAt: transferExpiry(now, request.expiresAt),
        },
        select: TRANSFER_SELECT,
      });
      this.logger.log(
        `Bank transfer ${row.id} opened for payment request ${request.id} (${request.network}, ${payee.pooled ? 'pooled' : 'seller'} merchant)`,
      );
      return { transfer: this.view(row, instructions), created: true };
    } catch (error) {
      // The same payer asked twice at once: the first one's row is the answer.
      if (!isUniqueViolation(error)) throw error;
      const row = await this.prisma.bankTransfer.findUnique({
        where: { paymentRequestId_documentHash: key },
        select: TRANSFER_SELECT,
      });
      if (!row) throw error;
      return { transfer: this.view(row, instructions), created: false };
    }
  }

  /**
   * The amount a new transfer asks: the request's, unless the same depositor
   * has another open transfer at the same merchant asking it (another charge
   * of the same amount), in which case a few cents more, so that the deposit
   * names one transfer only (`distinctAmount`). Open as matching reads it:
   * awaiting, up to the grace after expiry.
   */
  private async instructedAmount(
    network: StellarNetwork,
    merchantId: string,
    hash: string,
    amount: string,
    now: Date,
  ): Promise<string> {
    const open = await this.prisma.bankTransfer.findMany({
      where: {
        network,
        providerMerchantId: merchantId,
        documentHash: hash,
        status: 'awaiting_deposit',
        expiresAt: {
          gt: new Date(now.getTime() - BANK_TRANSFER_MATCH_GRACE_MS),
        },
      },
      select: { instructedAmount: true },
    });
    const instructed = distinctAmount(
      amount,
      open.map((transfer) => transfer.instructedAmount),
    );
    if (!instructed) {
      this.logger.error(
        `A depositor has 100 open bank transfers of ${amount} at merchant ${merchantId} (${network}): refusing another`,
      );
      throw ApiError.unavailable(ApiErrorCode.TransferUnavailable, UNAVAILABLE);
    }
    return instructed;
  }

  /** Where to transfer: the seller's own account, or the pooled one read from the provider. */
  private async instructions(
    payee: Payee,
    network: StellarNetwork,
  ): Promise<DepositInstructions> {
    if (payee.account) return payee.account;
    let pooled: DepositInstructions | null;
    try {
      pooled = await this.pooled.instructions(network, payee.merchantId);
    } catch (error) {
      this.logger.error(
        `${KOYWE_PROVIDER} (${network}) pooled deposit account could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      pooled = null;
    }
    if (!pooled) {
      throw ApiError.unavailable(ApiErrorCode.TransferUnavailable, UNAVAILABLE);
    }
    return pooled;
  }

  /**
   * An awaiting transfer asked for again while the request is open: past its
   * hour it gets a new one, and when the seller's account changed since (their
   * own was approved, or pooled mode took over) it follows the account the
   * payer is now told about, where its deposit will land.
   */
  private async renewIfStale<
    T extends {
      id: string;
      status: string;
      expiresAt: Date;
      providerMerchantId: string;
    },
  >(row: T, merchantId: string, requestExpiresAt: Date, now: Date): Promise<T> {
    if (row.status !== 'awaiting_deposit') return row;
    const stale = effectiveTransferStatus(row, now) === 'expired';
    const moved = row.providerMerchantId !== merchantId;
    if (!stale && !moved) return row;
    const data = {
      ...(stale ? { expiresAt: transferExpiry(now, requestExpiresAt) } : {}),
      ...(moved ? { providerMerchantId: merchantId } : {}),
    };
    await this.prisma.bankTransfer.updateMany({
      where: { id: row.id, status: 'awaiting_deposit' },
      data,
    });
    return { ...row, ...data };
  }

  private view(
    row: {
      id: string;
      status: string;
      currency: string;
      instructedAmount: string;
      documentHint: string;
      expiresAt: Date;
    },
    instructions: DepositInstructions,
  ): BankTransferView {
    return {
      id: row.id,
      status: effectiveTransferStatus(row, new Date()),
      currency: row.currency,
      amount: row.instructedAmount,
      alias: instructions.alias,
      cvu: instructions.cvu,
      holder: instructions.holder,
      bank: instructions.bank,
      documentHint: documentHintLabel(row.documentHint),
      expiresAt: row.expiresAt.toISOString(),
    };
  }
}
