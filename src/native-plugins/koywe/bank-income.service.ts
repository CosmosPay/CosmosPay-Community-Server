import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUniqueViolation } from '@/common/prisma-errors';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import {
  documentHash,
  readDepositorDocument,
} from '@/native-plugins/koywe/bank-transfer-document';
import { matchDeposit } from '@/native-plugins/koywe/bank-transfer';
import {
  keyNames,
  readBankIncome,
  type KoyweEnvelope,
} from '@/native-plugins/koywe/koywe-webhook';
import {
  BANK_TRANSFER_CURRENCY,
  BANK_TRANSFER_MATCH_CANDIDATES,
  BANK_TRANSFER_MATCH_GRACE_MS,
  KOYWE_PROVIDER,
} from '@/native-plugins/koywe/koywe.constants';
import { PrismaService } from '@/prisma/prisma.service';

/** What became of a deposit. */
export type BankIncomeOutcome = 'matched' | 'unmatched' | 'ignored';

/** A recorded deposit: whether it was seen before, and the transfer it matched. */
export interface RecordedBankIncome {
  duplicate: boolean;
  outcome: BankIncomeOutcome | null;
  transfer: { id: string; paymentRequestId: string } | null;
}

/**
 * Deposits (`bank_income.received`): each one is recorded with the delivery
 * that reported it and matched, in one transaction, to the transfer it pays.
 *
 * The candidates are the open transfers of the same depositor (by the HMAC of
 * their document's DNI part) into the same merchant on the same network: still
 * awaiting their deposit, also up to 24 hours past their expiry, because money
 * that arrived must reach the seller. A deposit pays the one asking exactly its
 * amount (every open transfer of a depositor at a merchant asks a different
 * one: `distinctAmount`), or, only when there is a single candidate, that one
 * if the deposit covers it. A larger deposit with several candidates could
 * belong to any of them (two charges of one buyer, or of two sellers in pooled
 * mode), so it pays none. The match is a conditional write (`awaiting_deposit`
 * to `converting`), so two deposits never take one transfer. A deposit nothing
 * matches is kept `unmatched` for ops to refund by hand, and one not in ARS or
 * not readable `ignored`; neither keeps the document, only its hash and three
 * digits.
 */
@Injectable()
export class BankIncomeService {
  private readonly logger = new Logger(BankIncomeService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Records `envelope` (a deposit verified as `network`'s) and matches it.
   * A delivery recorded before is a duplicate: nothing changes. Throws when it
   * cannot be stored, so the provider delivers it again.
   */
  async record(
    network: StellarNetwork,
    envelope: KoyweEnvelope,
  ): Promise<RecordedBankIncome> {
    const deposit = readBankIncome(envelope.data);
    if (deposit.missing.length > 0) {
      this.logger.warn(
        `${KOYWE_PROVIDER} deposit ${envelope.id} (${network}) lacks ${deposit.missing.join(', ')}; its data has: ${keyNames(envelope.data)}`,
      );
    }
    const depositor = readDepositorDocument(deposit.document);
    const pepper = this.config.get('koywe', { infer: true }).documentPepper;
    const hash =
      depositor && pepper ? documentHash(pepper, depositor.dniPart) : null;
    const merchantId = envelope.merchantId;
    const now = new Date();

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.bankTransferWebhookEvent.create({
          data: { id: envelope.id, network, type: envelope.type },
        });
        let outcome: BankIncomeOutcome;
        let reason: string | null;
        let transfer: { id: string; paymentRequestId: string } | null = null;
        if (deposit.currency !== BANK_TRANSFER_CURRENCY || !deposit.amount) {
          outcome = 'ignored';
          reason = deposit.amount
            ? `currency ${deposit.currency ?? 'unknown'}`
            : 'no amount';
        } else if (!hash) {
          outcome = 'unmatched';
          reason = 'no depositor document';
        } else if (!merchantId) {
          outcome = 'unmatched';
          reason = 'no merchant';
        } else {
          const candidates = await tx.bankTransfer.findMany({
            where: {
              network,
              providerMerchantId: merchantId,
              documentHash: hash,
              status: 'awaiting_deposit',
              expiresAt: {
                gt: new Date(now.getTime() - BANK_TRANSFER_MATCH_GRACE_MS),
              },
            },
            orderBy: { createdAt: 'asc' },
            take: BANK_TRANSFER_MATCH_CANDIDATES,
            select: {
              id: true,
              paymentRequestId: true,
              instructedAmount: true,
            },
          });
          const found = matchDeposit(candidates, deposit.amount);
          reason = found.reason;
          if (found.match) {
            const taken = await tx.bankTransfer.updateMany({
              where: { id: found.match.id, status: 'awaiting_deposit' },
              data: {
                status: 'converting',
                depositAmount: deposit.amount,
                depositReference: deposit.reference,
                depositedAt: now,
                nextAttemptAt: now,
              },
            });
            if (taken.count > 0) {
              transfer = {
                id: found.match.id,
                paymentRequestId: found.match.paymentRequestId,
              };
            } else {
              reason = 'its transfer was taken by another deposit';
            }
          }
          outcome = transfer ? 'matched' : 'unmatched';
        }
        await tx.bankIncomeEvent.create({
          data: {
            eventId: envelope.id,
            network,
            merchantId,
            outcome,
            amount: deposit.amount,
            currency: deposit.currency,
            documentHash: hash,
            documentHint: depositor?.hint ?? null,
            reference: deposit.reference,
            transferId: transfer?.id ?? null,
            reason,
          },
        });
        this.log(network, envelope.id, deposit, outcome, transfer, reason);
        return { duplicate: false, outcome, transfer };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.logger.log(
          `${KOYWE_PROVIDER} deposit ${envelope.id} (${network}) was already recorded: ignored`,
        );
        return { duplicate: true, outcome: null, transfer: null };
      }
      throw error;
    }
  }

  /** One line per deposit, with no document in it: unmatched money is an error, ops refunds it. */
  private log(
    network: StellarNetwork,
    eventId: string,
    deposit: {
      amount: string | null;
      currency: string | null;
      reference: string | null;
    },
    outcome: BankIncomeOutcome,
    transfer: { id: string } | null,
    reason: string | null,
  ): void {
    const what = `${KOYWE_PROVIDER} deposit ${eventId} (${network}, ${deposit.amount ?? '?'} ${deposit.currency ?? '?'}, reference ${deposit.reference ?? 'none'})`;
    if (outcome === 'matched') {
      this.logger.log(`${what} matched bank transfer ${transfer!.id}`);
    } else if (outcome === 'unmatched') {
      this.logger.error(
        `${what} matched no transfer (${reason}): it stays in the merchant's balance, refund it by hand`,
      );
    } else {
      this.logger.warn(`${what} ignored (${reason})`);
    }
  }
}
