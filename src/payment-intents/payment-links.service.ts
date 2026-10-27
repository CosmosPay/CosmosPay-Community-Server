import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@generated/prisma/client';
import { CHAIN_ADDRESS_RULES } from '@/chains/chain-address';
import { isChain } from '@/chains/chains.constants';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { readMerchantFeeRecord } from '@/common/merchant-fee/merchant-fee';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import type {
  SolanaPayInfoEntity,
  SolanaPayTransactionEntity,
} from '@/payment-intents/entities/solana-pay.entity';
import { SolanaPayTransactionBuilder } from '@/payment-intents/solana-pay-transaction.builder';
import type { PayerTransactionEntity } from '@/payment-intents/entities/payer-transaction.entity';
import { paymentLegs } from '@/payment-intents/payment-legs';
import { resolveAsset } from '@/stellar/asset';
import { STELLAR_DECIMALS } from '@/stellar/stellar.constants';
import { PrismaService } from '@/prisma/prisma.service';
import type { PublicPaymentLinkEntity } from '@/payment-intents/entities/public-payment-link.entity';
import {
  effectiveCheckoutTheme,
  SOLANA_PAY_ICON_PATH,
  SOLANA_PAY_LABEL,
} from '@/payment-intents/payment-intents.constants';
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
/**
 * How often a read of an open link writes `checkoutSeenAt`: the hosted page polls
 * every few seconds, and "seen in the last half minute" is all the owner reads
 * from it.
 */
export const PAYMENT_LINK_SEEN_EVERY_MS = 10_000;

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
  // Never answered (toPublicPaymentLink leaves it out): the Solana Pay
  // transaction is built in the token's own units.
  assetDecimals: true,
  memo: true,
  msg: true,
  uri: true,
  txHash: true,
  networkFee: true,
  merchantFee: true,
  expiresAt: true,
  createdAt: true,
  checkoutTheme: true,
} as const satisfies Prisma.PaymentIntentSelect;

/** An intent as the public read loads it. */
export type PaymentLinkRow = Prisma.PaymentIntentGetPayload<{
  select: typeof PAYMENT_LINK_SELECT;
}>;

/**
 * Whether `row` cannot be one wallet link and builds its envelope for its
 * payer instead: a Stellar PAY link with a merchant fee (SEP-7 `pay` pays one
 * account; the fee is a second payment).
 */
export function payerAccountRequired(
  row: Pick<PaymentLinkRow, 'chain' | 'kind' | 'merchantFee'>,
): boolean {
  return (
    row.chain === 'stellar' &&
    row.kind === 'PAY' &&
    readMerchantFeeRecord(row.merchantFee) !== null
  );
}

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
    merchantFee: readMerchantFeeRecord(row.merchantFee),
    payerAccountRequired: payerAccountRequired(row),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    checkoutTheme: effectiveCheckoutTheme(row.checkoutTheme),
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
    private readonly solanaPay: SolanaPayTransactionBuilder,
    private readonly config: ConfigService<AppConfig, true>,
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
    // The page polls this while a payer has it open: note it, so the owner sees
    // someone on the payment page. Never in the way of the answer.
    if (row.status === 'PENDING' || row.status === 'SUBMITTED') {
      void this.markSeen(id).catch(() => undefined);
    }
    // The same derivation the owner's reads use: QR of the stored URI, never
    // stored itself.
    return toPublicPaymentLink(row, await this.links.qr(row.uri));
  }

  /**
   * `checkoutSeenAt` = now for an open intent, at most every
   * {@link PAYMENT_LINK_SEEN_EVERY_MS} (a page polls every few seconds). Raw SQL so
   * `updatedAt` keeps meaning the last change of the intent itself.
   */
  private async markSeen(id: string): Promise<void> {
    const before = new Date(Date.now() - PAYMENT_LINK_SEEN_EVERY_MS);
    await this.prisma.$executeRaw`
      UPDATE "payment_intent"
         SET "checkoutSeenAt" = NOW()
       WHERE "id" = ${id}
         AND "status" IN ('PENDING', 'SUBMITTED')
         AND ("checkoutSeenAt" IS NULL OR "checkoutSeenAt" < ${before})
    `;
  }

  /**
   * The envelope the payer of a Stellar link with a merchant fee signs: the
   * payment to the merchant and the fee's, with the link's MEMO_ID, built on
   * `account`'s sequence number. Persists nothing: the verifier reads the
   * ledger, so any envelope that pays both legs with the memo settles the
   * link, and building another one (a lapsed timeout) costs nothing but a
   * Horizon read.
   *
   * Only for a link that needs it ({@link payerAccountRequired}) and is still
   * open: any other link has its own wallet link in `uri`, and a settled,
   * failed, cancelled or expired one is history.
   */
  async payerTransaction(
    id: string,
    account: string,
  ): Promise<PayerTransactionEntity> {
    const row = await this.prisma.paymentIntent.findUnique({
      where: { id },
      select: PAYMENT_LINK_SELECT,
    });
    if (!row) {
      throw ApiError.notFound(`Payment intent ${id} not found`);
    }
    if (!payerAccountRequired(row)) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'This payment link pays its destination directly: open its uri',
      );
    }
    if (row.status !== 'PENDING') {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Payment intent ${id} is ${row.status}: it can no longer be paid`,
      );
    }
    const legs = paymentLegs(row, STELLAR_DECIMALS);
    const { xdr, uri } = await this.links.tx(row.network as StellarNetwork, {
      source: account,
      destination: row.destination,
      amount: legs.destinationAmount!,
      asset: resolveAsset(row.asset, row.assetIssuer ?? undefined),
      memo: row.memo,
      msg: row.msg ?? undefined,
      fee: legs.fee,
    });
    return { xdr, uri, qr: await this.links.qr(uri) };
  }

  /**
   * The GET of a Solana Pay transaction request: who asks (a label) and an
   * icon, for the wallet to show before it asks for the transaction.
   */
  async solanaPayInfo(id: string): Promise<SolanaPayInfoEntity> {
    await this.solanaPayRow(id);
    const { checkoutUrl } = this.config.get('paymentIntents', { infer: true });
    return {
      label: SOLANA_PAY_LABEL,
      icon: `${checkoutUrl}${SOLANA_PAY_ICON_PATH}`,
    };
  }

  /**
   * The POST of a Solana Pay transaction request: the unsigned transaction
   * `account` signs, with the merchant's transfer, the fee's and the memo.
   * Persists nothing: the observer finds the payment by the link's reference.
   */
  async solanaPayTransaction(
    id: string,
    account: string,
  ): Promise<SolanaPayTransactionEntity> {
    if (!CHAIN_ADDRESS_RULES.solana.isValid(account)) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `account must be ${CHAIN_ADDRESS_RULES.solana.expected}`,
      );
    }
    const row = await this.solanaPayRow(id);
    if (row.status !== 'PENDING') {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Payment intent ${id} is ${row.status}: it can no longer be paid`,
      );
    }
    const transaction = await this.solanaPay.build(row, account);
    return { transaction, ...(row.msg ? { message: row.msg } : {}) };
  }

  /** A Solana link with a merchant fee: the only links that are transaction requests. */
  private async solanaPayRow(id: string): Promise<PaymentLinkRow> {
    const row = await this.prisma.paymentIntent.findUnique({
      where: { id },
      select: PAYMENT_LINK_SELECT,
    });
    if (!row) {
      throw ApiError.notFound(`Payment intent ${id} not found`);
    }
    if (row.chain !== 'solana' || !readMerchantFeeRecord(row.merchantFee)) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'This payment link is not a Solana Pay transaction request: open its uri',
      );
    }
    return row;
  }
}
