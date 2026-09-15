import { Injectable } from '@nestjs/common';
import type { Prisma } from '@generated/prisma/client';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { PaginationQueryDto } from '@/common/dto/pagination.query.dto';
import { page } from '@/common/pagination';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { PrismaService } from '@/prisma/prisma.service';
import { BlindpayOnrampApi } from '@/blindpay/blindpay-onramp.api';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import {
  BlindpaySyncService,
  BlindpayObject,
  PAYIN_PUBLIC_SELECT,
  PublicPayin,
} from '@/blindpay/blindpay-sync.service';
import { asString, isMirrorFresh } from '@/blindpay/blindpay.util';
import { CreatePayinQuoteDto } from '@/onramp/dto/create-payin-quote.dto';
import { CreatePayinDto } from '@/onramp/dto/create-payin.dto';
import { CreateTrustlineDto } from '@/onramp/dto/create-trustline.dto';

/**
 * What a single-payin read takes out of the mirror: the public projection, plus
 * the two columns `findOne` needs to decide on a refresh and perform it. Neither
 * is part of `PayinEntity`, so {@link toPublicPayin} drops them again before
 * anything is returned.
 *
 * `findOne` used to select these and hand the row back as read, so the same payin
 * came back in two shapes depending on how old its mirror row was: a fresh read
 * carried `receiverId` (an internal id) and `updatedAt`, while a stale one went
 * through `mirrorPayin` and `findAll` beside it returned the documented shape.
 * `OfframpService` already split its read this way.
 */
const PAYIN_READ_SELECT = {
  ...PAYIN_PUBLIC_SELECT,
  receiverId: true,
  updatedAt: true,
} as const satisfies Prisma.PayinSelect;

type MirroredPayin = Prisma.PayinGetPayload<{
  select: typeof PAYIN_READ_SELECT;
}>;

/**
 * Onramp (fiat -> stablecoin). Quotes are priced through BlindPay and returned
 * as-is (ephemeral, ~5 min). Payins are created from a quote, mirrored locally
 * with their funding instructions, and attributed to the consumer. The customer
 * funds the payin off-platform; BlindPay confirms via webhook.
 */
@Injectable()
export class OnrampService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blindpay: BlindpayOnrampApi,
    private readonly consumers: ConsumerResolverService,
    private readonly sync: BlindpaySyncService,
  ) {}

  async createQuote(consumer: GatewayConsumer, dto: CreatePayinQuoteDto) {
    const local = await this.consumers.resolve(consumer);
    const walletBlindpayId = await this.resolveWalletBlindpayId(
      local.id,
      dto.blockchain_wallet_id,
    );
    const quote = await this.blindpay.createPayinQuote({
      ...dto,
      blockchain_wallet_id: walletBlindpayId,
    });
    await this.recordQuoteOwnership(local.id, quote);
    return quote;
  }

  async createPayin(consumer: GatewayConsumer, dto: CreatePayinDto) {
    const local = await this.consumers.resolve(consumer);
    await this.assertQuoteOwned(local.id, dto.payin_quote_id);
    // One execution call for every destination network — the chain is determined
    // by the quote's wallet, not chosen here.
    const created = await this.blindpay.createPayin({
      payin_quote_id: dto.payin_quote_id,
    });
    const receiverId = await this.resolveReceiverLocalId(
      local.id,
      created.receiver_id,
    );
    return this.sync.mirrorPayin(local.id, receiverId, created);
  }

  async findAll(consumer: GatewayConsumer, query: PaginationQueryDto) {
    const local = await this.consumers.resolve(consumer);
    const where = { consumerId: local.id };
    // `total` is the row count, not the page length. Returning `data.length`
    // made the field useless: it always equalled what the caller just received,
    // so nobody could tell a full page from the last one.
    const [data, total] = await Promise.all([
      this.prisma.payin.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: PAYIN_PUBLIC_SELECT,
      }),
      this.prisma.payin.count({ where }),
    ]);
    return page(data, total, query);
  }

  /**
   * Reads a payin from the local mirror, refreshing from BlindPay only once the
   * mirrored row has gone stale (see {@link isMirrorFresh}). Webhooks carry
   * status changes, so the refresh only has to cover a missed delivery.
   */
  async findOne(consumer: GatewayConsumer, id: string): Promise<PublicPayin> {
    const local = await this.consumers.resolve(consumer);
    const row = await this.prisma.payin.findFirst({
      where: { id, consumerId: local.id },
      select: PAYIN_READ_SELECT,
    });
    if (!row) {
      throw ApiError.notFound('Payin not found');
    }
    if (isMirrorFresh(row)) {
      return toPublicPayin(row);
    }
    try {
      const fresh = await this.blindpay.getPayin(row.blindpayId);
      return await this.sync.mirrorPayin(local.id, row.receiverId, fresh);
    } catch {
      return toPublicPayin(row);
    }
  }

  /** Builds an unsigned Stellar trustline tx (XDR) for the customer to sign. */
  async createTrustline(consumer: GatewayConsumer, dto: CreateTrustlineDto) {
    await this.consumers.resolve(consumer);
    return this.blindpay.createAssetTrustline({ address: dto.address });
  }

  /**
   * Records who minted a quote, so {@link assertQuoteOwned} can authorize its
   * execution later.
   *
   * A missing id is a provider contract violation, not something to shrug off:
   * without the ownership row the quote can never be executed, and returning it
   * anyway would hand the caller a quote they are guaranteed to be refused on.
   */
  private async recordQuoteOwnership(
    consumerId: string,
    quote: BlindpayObject,
  ): Promise<void> {
    const blindpayId = asString(quote.id);
    if (!blindpayId) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        'BlindPay returned a payin quote without an id.',
      );
    }
    await this.prisma.blindpayQuote.create({
      data: { consumerId, blindpayId, kind: 'PAYIN' },
    });
  }

  /**
   * Proves the caller minted this quote before we execute it upstream.
   *
   * Every tenant shares one BlindPay platform instance, so holding a quote id
   * proves nothing about who owns it: forwarding `payin_quote_id` straight
   * through let one tenant execute another's quote and have the resulting payin
   * — funding instructions and bank details included — mirrored into their own
   * records. 404 rather than 403 is deliberate; a 403 would confirm the id is
   * live for somebody else.
   */
  private async assertQuoteOwned(
    consumerId: string,
    blindpayQuoteId: string,
  ): Promise<void> {
    const quote = await this.prisma.blindpayQuote.findUnique({
      where: {
        consumerId_blindpayId: { consumerId, blindpayId: blindpayQuoteId },
      },
    });
    // A payout quote id is equally not a payin quote id, so the kind is part of
    // the check rather than a separate 400 further upstream.
    if (!quote || quote.kind !== 'PAYIN') {
      throw ApiError.notFound('Quote not found', ApiErrorCode.QuoteNotFound);
    }
  }

  private async resolveWalletBlindpayId(
    consumerId: string,
    localWalletId: string,
  ): Promise<string> {
    const wallet = await this.prisma.blindpayBlockchainWallet.findFirst({
      where: { id: localWalletId, consumerId },
    });
    if (!wallet) {
      throw ApiError.notFound('Blockchain wallet not found');
    }
    // Block onramp for a disabled fiat account (the wallet's owning receiver).
    const receiver = await this.prisma.blindpayReceiver.findUnique({
      where: { id: wallet.receiverId },
      select: { disabled: true },
    });
    if (receiver?.disabled) {
      throw ApiError.forbidden(
        ApiErrorCode.AccountDisabled,
        'This fiat account is disabled. Re-enable it to use onramp.',
      );
    }
    return wallet.blindpayId;
  }

  private async resolveReceiverLocalId(
    consumerId: string,
    receiverBlindpayId: unknown,
  ): Promise<string | null> {
    if (!receiverBlindpayId) return null;
    const receiver = await this.prisma.blindpayReceiver.findFirst({
      where: { consumerId, blindpayId: asString(receiverBlindpayId) },
    });
    return receiver?.id ?? null;
  }
}

/** Drops the two columns {@link PAYIN_READ_SELECT} adds for `findOne`'s own use. */
function toPublicPayin({
  receiverId: _receiverId,
  updatedAt: _updatedAt,
  ...payin
}: MirroredPayin): PublicPayin {
  return payin;
}
