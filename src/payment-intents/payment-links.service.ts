import { Injectable } from '@nestjs/common';
import type { Prisma } from '@generated/prisma/client';
import { isChain } from '@/chains/chains.constants';
import { ApiError } from '@/common/errors/api-error';
import { PrismaService } from '@/prisma/prisma.service';
import type { PublicPaymentLinkEntity } from '@/payment-intents/entities/public-payment-link.entity';
import { PAY_TO } from '@/payment-intents/pay-to';
import { Sep7LinkBuilder } from '@/payment-intents/sep7-link-builder.service';

/**
 * The columns the public read loads: what a payer is shown, plus `destination`
 * and `chainReference`, which only decide `payTo` and never leave as themselves.
 *
 * Narrower than `PAYMENT_INTENT_PUBLIC_SELECT`, which is the OWNER's view and
 * carries `source`, `xdr`, `callback` and `reference`. Not loading them is the
 * first half of keeping them out of this response; {@link toPublicPaymentLink}
 * is the second.
 */
export const PAYMENT_LINK_SELECT = {
  id: true,
  kind: true,
  chain: true,
  network: true,
  status: true,
  destination: true,
  chainReference: true,
  amount: true,
  asset: true,
  assetIssuer: true,
  memo: true,
  msg: true,
  uri: true,
  txHash: true,
  networkFee: true,
  expiresAt: true,
  createdAt: true,
} as const satisfies Prisma.PaymentIntentSelect;

/** An intent as the public read loads it. */
export type PaymentLinkRow = Prisma.PaymentIntentGetPayload<{
  select: typeof PAYMENT_LINK_SELECT;
}>;

/**
 * What a payer may see of an intent, field by field.
 *
 * Written out rather than spread or projected: a spread answers with whatever
 * the row holds — and a full row, which is assignable to {@link PaymentLinkRow},
 * holds the consumer, the payer and the envelope — while this answers with
 * exactly the fields `PublicPaymentLinkEntity` documents, whatever it is given.
 */
export function toPublicPaymentLink(
  row: PaymentLinkRow,
  qr: string,
): PublicPaymentLinkEntity {
  const chain = row.chain;
  if (!isChain(chain)) {
    // Every write goes through a DTO that only admits the three chains, so this
    // is a corrupt row. A 500 beats showing a payer an address that may not be
    // the one their wallet will pay.
    throw new Error(`Payment intent ${row.id} is on unknown chain "${chain}"`);
  }
  return {
    id: row.id,
    kind: row.kind,
    chain,
    network: row.network,
    status: row.status,
    payTo: PAY_TO[chain](row),
    amount: row.amount,
    asset: row.asset,
    assetIssuer: row.assetIssuer,
    memo: row.memo,
    msg: row.msg,
    uri: row.uri,
    qr,
    txHash: row.txHash,
    networkFee: row.networkFee,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The anonymous read behind a hosted checkout page: one payment intent, by id,
 * redacted to what its payer may see.
 *
 * Not a method of `PaymentIntentsService`, whose every read is scoped to the
 * calling consumer. This one has no consumer — the route is `@Public()` — and
 * answers for any tenant's intent, so it is kept apart where it cannot borrow
 * that service's owner-shaped projection by accident.
 */
@Injectable()
export class PaymentLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly links: Sep7LinkBuilder,
  ) {}

  /**
   * The intent `id` as its payer sees it. The id is the capability: holding it
   * is what lets a payer open the link, so nothing else is asked for.
   *
   * An unknown id answers exactly what the owner's `GET /v1/payment-intents/{id}`
   * answers for one, and a deleted intent is gone from the table, so "never
   * existed" and "deleted" cannot be told apart.
   */
  async findPublic(id: string): Promise<PublicPaymentLinkEntity> {
    const row = await this.prisma.paymentIntent.findUnique({
      where: { id },
      select: PAYMENT_LINK_SELECT,
    });
    if (!row) {
      throw ApiError.notFound(`Payment intent ${id} not found`);
    }
    // The same derivation the owner's reads use: QR of the stored URI, never
    // stored itself.
    return toPublicPaymentLink(row, await this.links.qr(row.uri));
  }
}
