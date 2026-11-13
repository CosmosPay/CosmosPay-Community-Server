import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { StellarNetwork } from '@/config/configuration';
import { effectiveStatus } from '@/native-plugins/eldorado/p2p-payment-request';
import { REQUEST_ID_RE } from '@/native-plugins/eldorado/p2p-payment-requests.service';
import {
  PaymentRequestRails,
  type PaymentRequestLedger,
  type PaymentRequestRecord,
  type PaymentRequestSettlement,
} from '@/payment-request-rails/payment-request-rails';
import { PrismaService } from '@/prisma/prisma.service';

/** What another rail reads of a request: its terms, its owner's id and where it delivers. */
const LEDGER_SELECT = {
  id: true,
  consumerId: true,
  network: true,
  status: true,
  currency: true,
  amount: true,
  chainId: true,
  token: true,
  tokenAddress: true,
  tokenDecimals: true,
  address: true,
  expiresAt: true,
  paidAt: true,
} as const;

/**
 * The `p2p_payment_request` table as other plugins' rails reach it, through
 * the core's {@link PaymentRequestRails}: this plugin owns the table, so it is
 * the only one that writes it. Every write is conditional, so a rail that
 * reports the same thing twice changes nothing the second time, and the first
 * completion wins whichever rail it came from.
 */
@Injectable()
export class P2pPaymentRequestLedger
  implements PaymentRequestLedger, OnModuleInit
{
  private readonly logger = new Logger(P2pPaymentRequestLedger.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rails: PaymentRequestRails,
  ) {}

  onModuleInit(): void {
    this.rails.registerLedger(this);
  }

  async find(id: string): Promise<PaymentRequestRecord | null> {
    if (!REQUEST_ID_RE.test(id)) return null;
    const row = await this.prisma.p2pPaymentRequest.findUnique({
      where: { id },
      select: LEDGER_SELECT,
    });
    if (!row) return null;
    const { consumerId, ...rest } = row;
    return {
      ...rest,
      ownerId: consumerId,
      network: row.network as StellarNetwork,
      status: effectiveStatus(row, new Date()),
    };
  }

  /**
   * Money for the request arrived through another rail: it reads `processing`
   * until that rail delivers the token. An open request moves (an expired one
   * too: the money is in), and so does a cancelled one, whose payer had the
   * instructions before it was cancelled; a paid one never does. One that is
   * `processing` only because a direct order's payer said they transferred is
   * taken over (its `processingSessionId` cleared): money that arrived must
   * not be reopened when that order is cancelled.
   */
  async markProcessing(id: string, at: Date): Promise<boolean> {
    const moved = await this.prisma.p2pPaymentRequest.updateMany({
      where: {
        id,
        paidAt: null,
        OR: [
          { status: { in: ['open', 'cancelled'] } },
          { status: 'processing', processingSessionId: { not: null } },
        ],
      },
      data: { status: 'processing', processingSessionId: null, updatedAt: at },
    });
    if (moved.count > 0) {
      this.logger.log(`Payment request ${id} is processing`);
    }
    return moved.count > 0;
  }

  /**
   * The payer of the direct order recorded as `sessionId` said they
   * transferred: an open request (an expired one too) reads `processing`
   * because of that order until the marketplace completes or cancels it. A
   * request already processing (a bank transfer), paid or cancelled does not
   * move: true only when this call moved it.
   */
  async markDirectProcessing(
    id: string,
    sessionId: string,
    at: Date,
  ): Promise<boolean> {
    const moved = await this.prisma.p2pPaymentRequest.updateMany({
      where: { id, paidAt: null, status: 'open' },
      data: {
        status: 'processing',
        processingSessionId: sessionId,
        updatedAt: at,
      },
    });
    if (moved.count > 0) {
      this.logger.log(
        `Payment request ${id} is processing: the payer of session ${sessionId} transferred`,
      );
    }
    return moved.count > 0;
  }

  /**
   * The marketplace cancelled the direct order recorded as `sessionId`: a
   * request still `processing` because of THAT order (not paid, not taken over
   * by a bank transfer) is open again, and may read as expired. True when this
   * call reopened it.
   */
  async reopenAfterCancelledOrder(
    id: string,
    sessionId: string,
    at: Date,
  ): Promise<boolean> {
    const reopened = await this.prisma.p2pPaymentRequest.updateMany({
      where: {
        id,
        paidAt: null,
        status: 'processing',
        processingSessionId: sessionId,
      },
      data: { status: 'open', processingSessionId: null, updatedAt: at },
    });
    if (reopened.count > 0) {
      this.logger.warn(
        `Payment request ${id} is open again: the order of session ${sessionId}, which made it processing, was cancelled`,
      );
    }
    return reopened.count > 0;
  }

  /** Paid by another rail, unless a completion already paid it (logged: the first one wins). */
  async markPaid(
    id: string,
    settlement: PaymentRequestSettlement,
  ): Promise<boolean> {
    const paid = await this.prisma.p2pPaymentRequest.updateMany({
      where: { id, paidAt: null },
      data: {
        status: 'paid',
        paidAt: settlement.at,
        paidAmount: settlement.amount,
        paidTxHash: settlement.txHash,
        paidMethod: settlement.method,
      },
    });
    if (paid.count > 0) {
      this.logger.log(
        `Payment request ${id} paid by ${settlement.method} (${settlement.amount ?? '?'} delivered)`,
      );
    } else {
      this.logger.warn(
        `Payment request ${id} was already paid: this ${settlement.method} completion (${settlement.amount ?? '?'} delivered) changes nothing`,
      );
    }
    return paid.count > 0;
  }
}
