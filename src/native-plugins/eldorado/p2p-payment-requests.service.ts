import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toChecksumAddress } from '@/chains/chain-address';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { page } from '@/common/pagination';
import type { PaginationQueryDto } from '@/common/dto/pagination.query.dto';
import { PublicRecordTokens } from '@/common/public-record-token';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { resolveNetwork } from '@/common/stellar-network';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import {
  P2P_MARKETPLACE,
  P2P_PAYMENT_REQUEST_DEFAULT_MINUTES,
} from '@/native-plugins/eldorado/eldorado.constants';
import { estimateAmountOut } from '@/native-plugins/eldorado/p2p-market';
import {
  effectiveStatus,
  P2P_PAYMENT_REQUEST_PAYER_SELECT,
  paymentRequestUrl,
  toPublicPaymentRequest,
  type LiveBuyTerms,
  type PublicP2pPaymentRequest,
} from '@/native-plugins/eldorado/p2p-payment-request';
import { P2pRampService } from '@/native-plugins/eldorado/p2p-ramp.service';
import { PrismaService } from '@/prisma/prisma.service';
import { sep7Qr } from '@/stellar/sep7';

/** What the seller's reads load: every column but the consumer, the flags and the cancel time. */
const P2P_PAYMENT_REQUEST_PUBLIC_SELECT = {
  id: true,
  network: true,
  status: true,
  currency: true,
  amount: true,
  chainId: true,
  token: true,
  tokenAddress: true,
  tokenDecimals: true,
  address: true,
  description: true,
  estimatedAmountOut: true,
  expiresAt: true,
  createdAt: true,
  paidAt: true,
  paidAmount: true,
  paidTxHash: true,
} as const;

/** A request as {@link P2P_PAYMENT_REQUEST_PUBLIC_SELECT} loads it. */
interface SellerRow {
  id: string;
  network: string;
  status: string;
  currency: string;
  amount: string;
  chainId: number;
  token: string;
  tokenAddress: string;
  tokenDecimals: number;
  address: string;
  description: string | null;
  estimatedAmountOut: string | null;
  expiresAt: Date;
  createdAt: Date;
  paidAt: Date | null;
  paidAmount: string | null;
  paidTxHash: string | null;
}

/** What a payment request is created from, once its fields have passed the DTO. */
export interface P2pPaymentRequestInput {
  currency: string;
  amount: string;
  chainId: number;
  token: string;
  address: string;
  description?: string;
  expiresInMinutes?: number;
}

const NOT_FOUND = 'Payment request not found';

/** A payment request id as this service mints them (a cuid); anything else is a 404 before the table is read. */
const REQUEST_ID_RE = /^[a-z0-9]{1,64}$/;

/**
 * Payment requests: a charge in local money a seller shows as a QR, which a
 * payer pays through the P2P marketplace straight to the seller's wallet.
 *
 * The seller's side (`/v1/onramp/p2p/payment-requests`) is keyed like the
 * sessions: one consumer's rows on the key's network, the shared public key
 * reading back one row by its id and record token. The payer's side
 * (`/v1/payment-links/fiat/{id}`) has no consumer: the id is the capability,
 * and what it unlocks is bounded to reading the charge and opening a purchase
 * that delivers to the seller's own address, never anything about the owner.
 * Paying is recorded by the marketplace's webhook (`P2pOrderEventsService`).
 */
@Injectable()
export class P2pPaymentRequestsService {
  private readonly logger = new Logger(P2pPaymentRequestsService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly ramp: P2pRampService,
    private readonly recordTokens: PublicRecordTokens,
  ) {}

  /**
   * Creates a request on the key's network once the live market takes its
   * terms exactly as it would a purchase (currency, amount and its minimum,
   * chain and token; the payer picks the payment method later). The shared
   * public key also gets the request's `publicToken`.
   */
  async create(consumer: GatewayConsumer, input: P2pPaymentRequestInput) {
    const network = resolveNetwork(this.config, consumer);
    const { currency, token } = await this.ramp.checkOrderOn(
      network,
      {
        currency: input.currency,
        amount: input.amount,
        chainId: input.chainId,
        token: input.token,
        address: input.address,
      },
      'buy',
    );
    const local = await this.consumers.resolve(consumer);
    const minutes =
      input.expiresInMinutes ?? P2P_PAYMENT_REQUEST_DEFAULT_MINUTES;
    const row = await this.prisma.p2pPaymentRequest.create({
      data: {
        consumerId: local.id,
        network,
        sharedPublicKey: this.recordTokens.isSharedPublicKey(consumer),
        currency: currency.id,
        amount: input.amount,
        chainId: token.chainId,
        token: token.symbol,
        tokenAddress: token.address,
        tokenDecimals: token.decimals,
        address: toChecksumAddress(input.address),
        description: input.description ?? null,
        estimatedAmountOut: estimateAmountOut(
          input.amount,
          currency.price,
          token.priceUsd,
          'buy',
        ),
        status: 'open',
        expiresAt: new Date(Date.now() + minutes * 60 * 1000),
      },
      select: P2P_PAYMENT_REQUEST_PUBLIC_SELECT,
    });
    return this.recordTokens.attach(
      consumer,
      'p2p-payment-request',
      await this.sellerView(row),
    );
  }

  /** The consumer's requests on the key's network, newest first. */
  async findAll(consumer: GatewayConsumer, query: PaginationQueryDto) {
    const consumerId = await this.consumers.resolveId(consumer);
    const where = {
      consumerId,
      network: resolveNetwork(this.config, consumer),
    };
    const [rows, total] = await Promise.all([
      this.prisma.p2pPaymentRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: P2P_PAYMENT_REQUEST_PUBLIC_SELECT,
      }),
      this.prisma.p2pPaymentRequest.count({ where }),
    ]);
    const now = new Date();
    return page(
      await Promise.all(rows.map((row) => this.sellerView(row, now))),
      total,
      query,
    );
  }

  /**
   * One request of the consumer on the key's network; anyone else's, or one on
   * the other network, is the 404 of a missing one. The shared public key also
   * needs the request's record token: a missing or wrong one is the same 404,
   * decided before the table is read.
   */
  async findOne(consumer: GatewayConsumer, id: string, recordToken?: string) {
    return this.sellerView(await this.owned(consumer, id, recordToken));
  }

  /**
   * Cancels an open request (one past `expiresAt` reads as expired and is not
   * open): `409 request_closed` for any other. A cancelled request still turns
   * paid if a purchase already under way completes: the money arrived.
   */
  async cancel(consumer: GatewayConsumer, id: string, recordToken?: string) {
    const where = await this.ownedWhere(consumer, id, recordToken);
    const now = new Date();
    const cancelled = await this.prisma.p2pPaymentRequest.updateMany({
      where: { ...where, status: 'open', expiresAt: { gt: now } },
      data: { status: 'cancelled', cancelledAt: now },
    });
    const row = await this.prisma.p2pPaymentRequest.findFirst({
      where,
      select: P2P_PAYMENT_REQUEST_PUBLIC_SELECT,
    });
    if (!row) throw ApiError.notFound(NOT_FOUND);
    if (cancelled.count === 0) {
      throw ApiError.conflict(
        ApiErrorCode.RequestClosed,
        `Payment request ${id} is ${effectiveStatus(row, now)}: only an open one can be cancelled`,
      );
    }
    return this.sellerView(row, now);
  }

  /**
   * The request `id` as its payer sees it, with the live estimate and payment
   * methods ({@link toPublicPaymentRequest}): no consumer, the id is the
   * capability. A market that cannot be read leaves both empty instead of
   * failing the page.
   */
  async findPublic(id: string): Promise<PublicP2pPaymentRequest> {
    const row = REQUEST_ID_RE.test(id)
      ? await this.prisma.p2pPaymentRequest.findUnique({
          where: { id },
          select: P2P_PAYMENT_REQUEST_PAYER_SELECT,
        })
      : null;
    if (!row) throw ApiError.notFound(NOT_FOUND);
    return toPublicPaymentRequest(
      row,
      await this.liveTerms(row.network as StellarNetwork, row),
      new Date(),
    );
  }

  /**
   * Starts paying request `id` with `paymentMethod`: opens a purchase of its
   * exact terms, owned by the request's consumer (so it is in their sessions
   * and carries their referral id), linked to the request, and answers the
   * widget URL that takes it. `409 request_closed` unless the request is open;
   * `400 validation_failed` for a payment method the market does not offer for
   * the currency now (or terms it no longer takes).
   */
  async openPayerSession(
    id: string,
    paymentMethod: string,
  ): Promise<{ widgetUrl: string; reference: string }> {
    const row = REQUEST_ID_RE.test(id)
      ? await this.prisma.p2pPaymentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            consumerId: true,
            sharedPublicKey: true,
            network: true,
            status: true,
            expiresAt: true,
            currency: true,
            amount: true,
            chainId: true,
            tokenAddress: true,
            address: true,
          },
        })
      : null;
    if (!row) throw ApiError.notFound(NOT_FOUND);
    const status = effectiveStatus(row, new Date());
    if (status !== 'open') {
      throw ApiError.conflict(
        ApiErrorCode.RequestClosed,
        `Payment request ${id} is ${status}: it can no longer be paid`,
      );
    }
    const network = row.network as StellarNetwork;
    const order = {
      currency: row.currency,
      paymentMethod,
      chainId: row.chainId,
      token: row.tokenAddress,
      amount: row.amount,
      address: row.address,
    };
    const checked = await this.ramp.checkOrderOn(network, order, 'buy');
    const session = await this.ramp.recordSession(
      { consumerId: row.consumerId, sharedPublicKey: row.sharedPublicKey },
      network,
      'buy',
      order,
      checked,
      row.id,
    );
    return { widgetUrl: session.widgetUrl, reference: session.reference };
  }

  /** The market's answer for a request's terms, or nothing when it cannot be read. */
  private async liveTerms(
    network: StellarNetwork,
    row: { currency: string; chainId: number; tokenAddress: string },
  ): Promise<LiveBuyTerms> {
    try {
      return await this.ramp.buyTerms(
        network,
        row.currency,
        row.chainId,
        row.tokenAddress,
      );
    } catch (error) {
      this.logger.warn(
        `The ${P2P_MARKETPLACE} market (${network}) could not be read for a payment request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { currency: null, token: null };
    }
  }

  /**
   * The consumer's own request on the key's network, or the 404 of a missing
   * one; the shared public key also needs its record token, checked first.
   */
  private async owned(
    consumer: GatewayConsumer,
    id: string,
    recordToken?: string,
  ): Promise<SellerRow> {
    const row = await this.prisma.p2pPaymentRequest.findFirst({
      where: await this.ownedWhere(consumer, id, recordToken),
      select: P2P_PAYMENT_REQUEST_PUBLIC_SELECT,
    });
    if (!row) throw ApiError.notFound(NOT_FOUND);
    return row;
  }

  /** The filter of one request this caller owns: the id, its consumer and the key's network. */
  private async ownedWhere(
    consumer: GatewayConsumer,
    id: string,
    recordToken?: string,
  ): Promise<{ id: string; consumerId: string; network: StellarNetwork }> {
    if (
      !this.recordTokens.admits(
        consumer,
        'p2p-payment-request',
        id,
        recordToken,
      )
    ) {
      throw ApiError.notFound(NOT_FOUND);
    }
    return {
      id,
      consumerId: await this.consumers.resolveId(consumer),
      network: resolveNetwork(this.config, consumer),
    };
  }

  /**
   * A request as its seller reads it, field by field: the link to show (`url`,
   * the payer's page) and its QR, derived and never stored, and the status it
   * reads as at `now`.
   */
  private async sellerView(row: SellerRow, now = new Date()) {
    const url = paymentRequestUrl(
      this.config.get('paymentIntents', { infer: true }).checkoutUrl,
      row.id,
    );
    return {
      id: row.id,
      network: row.network,
      status: effectiveStatus(row, now),
      currency: row.currency,
      amount: row.amount,
      chainId: row.chainId,
      token: row.token,
      tokenAddress: row.tokenAddress,
      tokenDecimals: row.tokenDecimals,
      address: row.address,
      description: row.description,
      estimatedAmountOut: row.estimatedAmountOut,
      url,
      qr: await sep7Qr(url),
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      paidAt: row.paidAt ? row.paidAt.toISOString() : null,
      paidAmount: row.paidAmount,
      paidTxHash: row.paidTxHash,
    };
  }
}
