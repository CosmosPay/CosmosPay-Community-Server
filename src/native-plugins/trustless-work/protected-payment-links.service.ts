import { Injectable } from '@nestjs/common';
import type { ProtectedPayment } from '@generated/prisma/client';
import { ApiError } from '@/common/errors/api-error';
import { PrismaService } from '@/prisma/prisma.service';
import type { DisputeProtectedPaymentLinkDto } from '@/native-plugins/trustless-work/dto/protected-payment.dto';
import {
  type BuiltTransaction,
  ProtectedPaymentActionsService,
  type SubmittedTransaction,
} from '@/native-plugins/trustless-work/protected-payment-actions.service';
import {
  type BuyerView,
  buyerView,
} from '@/native-plugins/trustless-work/protected-payment-views';

/** A build, as the payment link answers it. */
export type LinkBuild = Omit<BuiltTransaction, 'payment'> & {
  protectedPayment: BuyerView;
};

/** A relay, as the payment link answers it. */
export type LinkSubmit = Omit<SubmittedTransaction, 'payment'> & {
  protectedPayment: BuyerView;
};

/** The ids are uuids (v4, 122 random bits): anything else names no payment. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The buyer's side of a protected payment: what the hosted checkout
 * (`<payments origin>/protected/<id>`) calls from the buyer's browser, with no
 * API key (`@Public()` routes, so there is no consumer here at all).
 *
 * **The id is the capability**, as for a payment link: the row is loaded by its
 * id alone, on purpose, because the buyer has no account with this service and
 * the merchant gave them the link. That is safe because nothing the id alone
 * unlocks moves money or costs anything that is not bounded:
 *
 *  - the read answers the buyer's projection (`PROTECTED_PAYMENT_LINK_SELECT`),
 *    never the merchant's consumer, `reference` or any internal column;
 *  - every envelope it builds is for the bound buyer to sign, and does nothing
 *    until that key signs it;
 *  - the one build that spends the platform's XLM, the deploy, happens once per
 *    payment, binds the buyer (a different one later is 409), and only after
 *    Horizon shows the buyer holds the amount;
 *  - a dispute the platform opens for a buyer without an on-chain role needs a
 *    signature by the buyer's key (`protected-payment-dispute-challenge.ts`).
 *
 * The id is a uuid v4; a value that is not one is the 404 of a missing payment,
 * answered before the table is read. Every route is budgeted per client address.
 */
@Injectable()
export class ProtectedPaymentLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actions: ProtectedPaymentActionsService,
  ) {}

  async findPublic(id: string): Promise<BuyerView> {
    return buyerView(await this.find(id), new Date());
  }

  async fund(id: string, buyer: string): Promise<LinkBuild> {
    return this.buildView(await this.actions.fund(await this.find(id), buyer));
  }

  async approve(id: string): Promise<LinkBuild> {
    return this.buildView(
      await this.actions.approve(await this.find(id), 'BUYER'),
    );
  }

  async release(id: string): Promise<LinkBuild> {
    return this.buildView(
      await this.actions.release(await this.find(id), 'BUYER'),
    );
  }

  async dispute(
    id: string,
    dto: DisputeProtectedPaymentLinkDto,
  ): Promise<{ built: LinkBuild | null; submitted: LinkSubmit | null }> {
    const outcome = await this.actions.dispute(
      await this.find(id),
      'BUYER',
      dto.reason ?? null,
      dto.signature && dto.expiresAt
        ? { signature: dto.signature, expiresAt: dto.expiresAt }
        : undefined,
    );
    return outcome.built
      ? { built: this.buildView(outcome.built), submitted: null }
      : { built: null, submitted: this.submitView(outcome.submitted) };
  }

  /** Relays a buyer-signed transaction built for this payment link. */
  async submit(id: string, xdr: string): Promise<LinkSubmit> {
    const row = await this.find(id);
    if (!row.buyerAddress) throw notFound(id);
    return this.submitView(
      await this.actions.submit(row, { signer: row.buyerAddress }, xdr),
    );
  }

  private async find(id: string): Promise<ProtectedPayment> {
    if (!UUID_RE.test(id)) throw notFound(id);
    const row = await this.prisma.protectedPayment.findUnique({
      where: { id },
    });
    if (!row) throw notFound(id);
    return row;
  }

  private buildView(built: BuiltTransaction): LinkBuild {
    const { payment, ...rest } = built;
    return { ...rest, protectedPayment: buyerView(payment, new Date()) };
  }

  private submitView(submitted: SubmittedTransaction): LinkSubmit {
    const { payment, ...rest } = submitted;
    return { ...rest, protectedPayment: buyerView(payment, new Date()) };
  }
}

function notFound(id: string): ApiError {
  return ApiError.notFound(`Protected payment ${id} not found`);
}
