import { Injectable } from '@nestjs/common';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { PaginationQueryDto } from '@/common/dto/pagination.query.dto';
import { page } from '@/common/pagination';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { PrismaService } from '@/prisma/prisma.service';
import {
  BlindpayOfframpApi,
  type BlindpayPayoutRequest,
} from '@/blindpay/blindpay-offramp.api';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import {
  BlindpaySyncService,
  BlindpayObject,
  PAYOUT_PUBLIC_SELECT,
  PublicPayout,
} from '@/blindpay/blindpay-sync.service';
import { asString, asNumber, isMirrorFresh } from '@/blindpay/blindpay.util';
import type { Prisma } from '@generated/prisma/client';
import type { BlindpayEnvironment } from '@/config/configuration';
import { CreatePayoutQuoteDto } from '@/offramp/dto/create-payout-quote.dto';
import { AuthorizePayoutDto } from '@/offramp/dto/authorize-payout.dto';
import { CreatePayoutDto } from '@/offramp/dto/create-payout.dto';
import { PayoutDocumentDto } from '@/offramp/dto/payout-document.dto';

/**
 * What a single-payout read takes out of the mirror: the public projection, plus
 * the two columns `findOne` needs to decide on a refresh and perform it. Neither
 * of those is part of `PayoutEntity`, so {@link toPublicPayout} drops them again
 * before anything is returned.
 */
const PAYOUT_READ_SELECT = {
  ...PAYOUT_PUBLIC_SELECT,
  receiverId: true,
  updatedAt: true,
} as const satisfies Prisma.PayoutSelect;

type MirroredPayout = Prisma.PayoutGetPayload<{
  select: typeof PAYOUT_READ_SELECT;
}>;

/**
 * Offramp (stablecoin -> fiat). Quotes are priced through BlindPay (the EVM quote
 * carries the `approve` contract the customer signs). The customer signs the
 * on-chain transfer — the service never holds keys: for Stellar/Solana it returns
 * the unsigned tx via {@link authorize} and accepts the signed one back on create.
 * Payouts are mirrored locally and BlindPay confirms settlement via webhook. Every
 * read and write stays on the BlindPay instance the caller's key environment
 * selects: a dev key moves no real money.
 */
@Injectable()
export class OfframpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blindpay: BlindpayOfframpApi,
    private readonly consumers: ConsumerResolverService,
    private readonly sync: BlindpaySyncService,
  ) {}

  async createQuote(consumer: GatewayConsumer, dto: CreatePayoutQuoteDto) {
    const local = await this.consumers.resolve(consumer);
    const environment = this.blindpay.environmentFor(consumer);
    const bankAccountBlindpayId = await this.resolveBankAccountBlindpayId(
      local.id,
      environment,
      dto.bank_account_id,
    );
    const quote = await this.blindpay.createPayoutQuote(environment, {
      ...dto,
      bank_account_id: bankAccountBlindpayId,
    });
    await this.recordQuoteOwnership(local.id, environment, quote);
    // BlindPay carries the local fiat amount (e.g. ARS) in `receiver_amount`;
    // `receiver_local_amount` comes back 0. Surface the real amount under the
    // documented field so callers don't read 0. Keep the raw fields too.
    const localAmount =
      asNumber(quote.receiver_local_amount) || asNumber(quote.receiver_amount);
    return { ...quote, receiver_local_amount: localAmount };
  }

  /** Step 1 for Stellar/Solana: returns the unsigned tx for the customer to sign. */
  async authorize(consumer: GatewayConsumer, dto: AuthorizePayoutDto) {
    const local = await this.consumers.resolve(consumer);
    const environment = this.blindpay.environmentFor(consumer);
    await this.assertQuoteOwned(local.id, environment, dto.quote_id);
    const res = await this.blindpay.authorizePayout(environment, dto.chain, {
      quote_id: dto.quote_id,
      sender_wallet_address: dto.sender_wallet_address,
    });
    // BlindPay returns the unsigned tx under `transaction_hash` (a misnomer — it's
    // the XDR to sign, not a hash). Expose it under a clear, stable field so the
    // wallet can find it, while keeping the raw payload for safety.
    const unsignedTransaction =
      asString(res.transaction_hash) ||
      asString(res.unsigned_transaction) ||
      asString(res.transaction) ||
      asString(res.xdr);
    return { ...res, unsigned_transaction: unsignedTransaction };
  }

  async createPayout(consumer: GatewayConsumer, dto: CreatePayoutDto) {
    const local = await this.consumers.resolve(consumer);
    const environment = this.blindpay.environmentFor(consumer);
    await this.assertQuoteOwned(local.id, environment, dto.quote_id);
    const body: BlindpayPayoutRequest = {
      quote_id: dto.quote_id,
      sender_wallet_address: dto.sender_wallet_address,
    };
    if (dto.signed_transaction !== undefined) {
      body.signed_transaction = dto.signed_transaction;
    }
    const created = await this.blindpay.createPayout(
      environment,
      dto.chain,
      body,
    );
    const receiverId = await this.resolveReceiverLocalId(
      local.id,
      environment,
      created.receiver_id,
    );
    return this.sync.mirrorPayout(local.id, environment, receiverId, created);
  }

  async findAll(consumer: GatewayConsumer, query: PaginationQueryDto) {
    const local = await this.consumers.resolve(consumer);
    const where = {
      consumerId: local.id,
      environment: this.blindpay.environmentFor(consumer),
    };
    // `total` is the row count, not the page length. Returning `data.length`
    // made the field useless: it always equalled what the caller just received,
    // so nobody could tell a full page from the last one.
    const [data, total] = await Promise.all([
      this.prisma.payout.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: PAYOUT_PUBLIC_SELECT,
      }),
      this.prisma.payout.count({ where }),
    ]);
    return page(data, total, query);
  }

  /**
   * Reads a payout from the local mirror, refreshing from BlindPay only once the
   * mirrored row has gone stale (see {@link isMirrorFresh}). Webhooks carry
   * status changes, so the refresh only has to cover a missed delivery.
   */
  async findOne(consumer: GatewayConsumer, id: string): Promise<PublicPayout> {
    const local = await this.consumers.resolve(consumer);
    const environment = this.blindpay.environmentFor(consumer);
    const row = await this.findPayoutOrThrow(local.id, environment, id);
    if (isMirrorFresh(row)) {
      return toPublicPayout(row);
    }
    try {
      const fresh = await this.blindpay.getPayout(environment, row.blindpayId);
      return await this.sync.mirrorPayout(
        local.id,
        environment,
        row.receiverId,
        fresh,
      );
    } catch {
      return toPublicPayout(row);
    }
  }

  async addDocument(
    consumer: GatewayConsumer,
    id: string,
    dto: PayoutDocumentDto,
  ) {
    const local = await this.consumers.resolve(consumer);
    const environment = this.blindpay.environmentFor(consumer);
    const row = await this.findPayoutOrThrow(local.id, environment, id);
    return this.blindpay.addPayoutDocument(environment, row.blindpayId, dto);
  }

  /**
   * Records who minted a quote, and on which instance, so {@link assertQuoteOwned}
   * can authorize its execution later.
   *
   * A missing id is a provider contract violation, not something to shrug off:
   * without the ownership row the quote can never be authorized or executed, and
   * returning it anyway would hand the caller a quote they are guaranteed to be
   * refused on.
   */
  private async recordQuoteOwnership(
    consumerId: string,
    environment: BlindpayEnvironment,
    quote: BlindpayObject,
  ): Promise<void> {
    const blindpayId = asString(quote.id);
    if (!blindpayId) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        'BlindPay returned a payout quote without an id.',
      );
    }
    await this.prisma.blindpayQuote.create({
      data: { consumerId, environment, blindpayId, kind: 'PAYOUT' },
    });
  }

  /**
   * Proves the caller minted this quote, on its own instance, before we authorize
   * or execute it upstream.
   *
   * Every tenant of an environment shares one BlindPay platform instance, so
   * holding a quote id proves nothing about who owns it: forwarding `quote_id`
   * straight through let one tenant execute another's quote and have the
   * resulting payout — bank details included — mirrored into their own records.
   * 404 rather than 403 is deliberate; a 403 would confirm the id is live for
   * somebody else.
   */
  private async assertQuoteOwned(
    consumerId: string,
    environment: BlindpayEnvironment,
    blindpayQuoteId: string,
  ): Promise<void> {
    const quote = await this.prisma.blindpayQuote.findUnique({
      where: {
        consumerId_blindpayId: { consumerId, blindpayId: blindpayQuoteId },
      },
    });
    // A payin quote id is equally not a payout quote id, and a quote minted on
    // the other instance does not exist on this one, so both are part of the
    // check rather than a separate error further upstream.
    if (
      !quote ||
      quote.kind !== 'PAYOUT' ||
      quote.environment !== environment
    ) {
      throw ApiError.notFound('Quote not found', ApiErrorCode.QuoteNotFound);
    }
  }

  /**
   * Reads a payout the caller owns on its instance, narrowed to
   * {@link PAYOUT_READ_SELECT}.
   *
   * This used to read the whole row, and `findOne` returned it as-is: `raw` —
   * the BlindPay payload, beneficiary bank details included — beside internal
   * ids (`consumerId`, `quoteId`, `bankAccountId`) that `PAYOUT_PUBLIC_SELECT`
   * exists to keep in PostgreSQL. `addDocument` only needs `blindpayId`, which
   * the projection carries, so neither caller has a reason to read the blob.
   */
  private async findPayoutOrThrow(
    consumerId: string,
    environment: BlindpayEnvironment,
    id: string,
  ): Promise<MirroredPayout> {
    const row = await this.prisma.payout.findFirst({
      where: { id, consumerId, environment },
      select: PAYOUT_READ_SELECT,
    });
    if (!row) {
      throw ApiError.notFound('Payout not found');
    }
    return row;
  }

  private async resolveBankAccountBlindpayId(
    consumerId: string,
    environment: BlindpayEnvironment,
    localId: string,
  ): Promise<string> {
    const account = await this.prisma.blindpayBankAccount.findFirst({
      where: { id: localId, consumerId, environment },
    });
    if (!account) {
      throw ApiError.notFound('Bank account not found');
    }
    // Block offramp for a disabled fiat account (the bank account's owning receiver).
    const receiver = await this.prisma.blindpayReceiver.findUnique({
      where: { id: account.receiverId },
      select: { disabled: true },
    });
    if (receiver?.disabled) {
      throw ApiError.forbidden(
        ApiErrorCode.AccountDisabled,
        'This fiat account is disabled. Re-enable it to use offramp.',
      );
    }
    return account.blindpayId;
  }

  private async resolveReceiverLocalId(
    consumerId: string,
    environment: BlindpayEnvironment,
    receiverBlindpayId: unknown,
  ): Promise<string | null> {
    if (!receiverBlindpayId) return null;
    const receiver = await this.prisma.blindpayReceiver.findFirst({
      where: {
        consumerId,
        environment,
        blindpayId: asString(receiverBlindpayId),
      },
    });
    return receiver?.id ?? null;
  }
}

/** Drops the two columns {@link PAYOUT_READ_SELECT} adds for `findOne`'s own use. */
function toPublicPayout({
  receiverId: _receiverId,
  updatedAt: _updatedAt,
  ...payout
}: MirroredPayout): PublicPayout {
  return payout;
}
