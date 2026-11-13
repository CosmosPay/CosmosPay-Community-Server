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
import {
  directConfigured,
  p2pDirectAvailable,
} from '@/native-plugins/eldorado/p2p-direct';
import {
  estimateAmountOut,
  type P2pCurrency,
  type P2pToken,
} from '@/native-plugins/eldorado/p2p-market';
import {
  effectiveStatus,
  P2P_PAYMENT_REQUEST_PAYER_SELECT,
  p2pTakes,
  paymentRequestUrl,
  storedMethods,
  toPublicPaymentRequest,
  type LiveBuyTerms,
  type PublicP2pPaymentRequest,
} from '@/native-plugins/eldorado/p2p-payment-request';
import {
  P2pRampService,
  type CheckedP2pOrder,
} from '@/native-plugins/eldorado/p2p-ramp.service';
import {
  PaymentRequestRails,
  type PaymentRequestMethod,
  type PaymentRequestTerms,
  type PaymentRequestToken,
} from '@/payment-request-rails/payment-request-rails';
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
  methods: true,
  expiresAt: true,
  createdAt: true,
  paidAt: true,
  paidAmount: true,
  paidTxHash: true,
  paidMethod: true,
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
  methods: string[];
  expiresAt: Date;
  createdAt: Date;
  paidAt: Date | null;
  paidAmount: string | null;
  paidTxHash: string | null;
  paidMethod: string | null;
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
export const REQUEST_ID_RE = /^[a-z0-9]{1,64}$/;

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
 *
 * Other plugins may serve other ways to pay (a bank transfer): they register a
 * rail in {@link PaymentRequestRails}, which this service consults to decide
 * a request's `methods` when it is created and every time it is read.
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
    private readonly rails: PaymentRequestRails,
  ) {}

  /**
   * Creates a request on the key's network once at least one rail takes its
   * terms: the live market exactly as it would a purchase (currency, amount
   * and its minimum, chain and token; the payer picks the payment method
   * later), or another plugin's rail (a bank transfer). When none does, the
   * market's refusal is the answer, as before there were other rails. The
   * rails that took it are stored as `methods`. The shared public key also
   * gets the request's `publicToken`.
   */
  async create(consumer: GatewayConsumer, input: P2pPaymentRequestInput) {
    const network = resolveNetwork(this.config, consumer);
    const local = await this.consumers.resolve(consumer);
    const terms: PaymentRequestTerms = {
      ownerId: local.id,
      network,
      currency: input.currency,
      amount: input.amount,
      chainId: input.chainId,
      tokenAddress: input.token,
    };
    let checked: CheckedP2pOrder | null = null;
    let refusal: unknown = null;
    try {
      checked = await this.ramp.checkOrderOn(
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
    } catch (error) {
      refusal = error;
    }
    // What the market lists for the pair even when it refused the order (an
    // amount under its minimum): the estimate, and the pairs a sandbox rail takes.
    const live =
      checked ??
      (await this.liveTerms(network, {
        currency: input.currency,
        chainId: input.chainId,
        tokenAddress: input.token,
      }));
    const listed = live?.token ? tokenOf(live.token) : null;
    const otherRails = await this.rails.accepting(terms, listed);
    if (!checked && otherRails.length === 0) throw refusal;
    const methods = await this.rails.methodsFor(
      terms,
      listed,
      checked !== null,
    );
    const token = deliveredToken(input, live?.token ?? null, otherRails);
    const minutes =
      input.expiresInMinutes ?? P2P_PAYMENT_REQUEST_DEFAULT_MINUTES;
    const row = await this.prisma.p2pPaymentRequest.create({
      data: {
        consumerId: local.id,
        network,
        sharedPublicKey: this.recordTokens.isSharedPublicKey(consumer),
        currency: checked ? checked.currency.id : input.currency,
        amount: input.amount,
        chainId: token.chainId,
        token: token.symbol,
        tokenAddress: token.address,
        tokenDecimals: token.decimals,
        address: toChecksumAddress(input.address),
        description: input.description ?? null,
        estimatedAmountOut: estimateOf(input.amount, live),
        methods,
        status: 'open',
        expiresAt: new Date(Date.now() + minutes * 60 * 1000),
      },
      select: P2P_PAYMENT_REQUEST_PUBLIC_SELECT,
    });
    return this.recordTokens.attach(
      consumer,
      'p2p-payment-request',
      await this.sellerView(row, local.id),
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
      await Promise.all(
        rows.map((row) => this.sellerView(row, consumerId, now)),
      ),
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
    const where = await this.ownedWhere(consumer, id, recordToken);
    const row = await this.prisma.p2pPaymentRequest.findFirst({
      where,
      select: P2P_PAYMENT_REQUEST_PUBLIC_SELECT,
    });
    if (!row) throw ApiError.notFound(NOT_FOUND);
    return this.sellerView(row, where.consumerId);
  }

  /**
   * Cancels an open request (one past `expiresAt` reads as expired and is not
   * open): `409 request_closed` for any other, a `processing` one included
   * (its money arrived). A cancelled request still turns paid if a purchase
   * already under way completes: the money arrived.
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
    return this.sellerView(row, where.consumerId, now);
  }

  /**
   * The request `id` as its payer sees it, with the live estimate, payment
   * methods and rails ({@link toPublicPaymentRequest}): no consumer, the id is
   * the capability. A market that cannot be read leaves the estimate and the
   * payment methods empty instead of failing the page, and `p2p` then stays
   * in `methods` as stored at creation.
   */
  async findPublic(id: string): Promise<PublicP2pPaymentRequest> {
    const row = REQUEST_ID_RE.test(id)
      ? await this.prisma.p2pPaymentRequest.findUnique({
          where: { id },
          select: P2P_PAYMENT_REQUEST_PAYER_SELECT,
        })
      : null;
    if (!row) throw ApiError.notFound(NOT_FOUND);
    const network = row.network as StellarNetwork;
    const live = await this.liveTerms(network, row);
    const methods = await this.methodsOf(
      { ...row, network, ownerId: await this.ownerOf(row.id) },
      p2pTakes(row.amount, live) ?? storedMethods(row.methods).includes('p2p'),
    );
    return toPublicPaymentRequest(
      row,
      live ?? { currency: null, token: null },
      methods,
      new Date(),
      this.directOn,
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

  /**
   * The rails that can pay a stored request now, in preference order: each
   * other plugin's rail asked again (it may have been switched on or off since),
   * and `p2p` as the caller decided it. The pair was listed when the request
   * was created, so the stored token stands for the market's listing.
   */
  private methodsOf(
    row: {
      ownerId: string | null;
      network: StellarNetwork;
      currency: string;
      amount: string;
      chainId: number;
      tokenAddress: string;
      token: string;
      tokenDecimals: number;
    },
    p2p: boolean,
  ): Promise<PaymentRequestMethod[]> {
    if (row.ownerId === null) return Promise.resolve(p2p ? ['p2p'] : []);
    return this.rails.methodsFor(
      {
        ownerId: row.ownerId,
        network: row.network,
        currency: row.currency,
        amount: row.amount,
        chainId: row.chainId,
        tokenAddress: row.tokenAddress,
      },
      { symbol: row.token, decimals: row.tokenDecimals },
      p2p,
    );
  }

  /** Whether this deployment serves the direct flow at all (its ids and its session secret). */
  private get directOn(): boolean {
    return directConfigured(this.config.get('eldorado', { infer: true }));
  }

  /**
   * The local id of a request's owner, for the rails only (never answered):
   * loaded on its own, apart from the payer's projection, and only when another
   * plugin registered a rail that may need it.
   */
  private async ownerOf(id: string): Promise<string | null> {
    if (!this.rails.hasRails()) return null;
    const row = await this.prisma.p2pPaymentRequest.findUnique({
      where: { id },
      select: { consumerId: true },
    });
    return row?.consumerId ?? null;
  }

  /** The market's answer for a request's terms, or null when it cannot be read. */
  private async liveTerms(
    network: StellarNetwork,
    row: { currency: string; chainId: number; tokenAddress: string },
  ): Promise<LiveBuyTerms | null> {
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
      return null;
    }
  }

  /**
   * The filter of one request this caller owns: the id, its consumer and the
   * key's network. The shared public key also needs its record token, checked
   * first: a missing or wrong one is the 404 of a missing request.
   */
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
   * the payer's page) and its QR, derived and never stored, the status it
   * reads as at `now`, and the rails that can pay it now (the market is not
   * read here: `p2p` is as stored at creation), with `p2pDirect` from them.
   */
  private async sellerView(row: SellerRow, ownerId: string, now = new Date()) {
    const url = paymentRequestUrl(
      this.config.get('paymentIntents', { infer: true }).checkoutUrl,
      row.id,
    );
    const methods = await this.methodsOf(
      { ...row, ownerId, network: row.network as StellarNetwork },
      storedMethods(row.methods).includes('p2p'),
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
      methods,
      p2pDirect: p2pDirectAvailable(this.directOn, {
        currency: row.currency,
        methods,
      }),
      url,
      qr: await sep7Qr(url),
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      paidAt: row.paidAt ? row.paidAt.toISOString() : null,
      paidAmount: row.paidAmount,
      paidTxHash: row.paidTxHash,
      paidMethod: paidMethodOf(row.paidMethod),
    };
  }
}

/** A market token as a rail reads it. */
function tokenOf(token: P2pToken): PaymentRequestToken {
  return { symbol: token.symbol, decimals: token.decimals };
}

/**
 * The token a new request stores: the market's listing of the pair when it
 * has one (whichever rail pays, so a request reads the same either way), else
 * the token the first other rail that took it delivers.
 */
function deliveredToken(
  input: P2pPaymentRequestInput,
  listed: P2pToken | null,
  otherRails: { token: PaymentRequestToken }[],
): { chainId: number; address: string; symbol: string; decimals: number } {
  if (listed) return listed;
  const { symbol, decimals } = otherRails[0].token;
  return {
    chainId: input.chainId,
    address: toChecksumAddress(input.token),
    symbol,
    decimals,
  };
}

/** The market price's estimate for `amount`, or null when the market could not price it. */
function estimateOf(
  amount: string,
  live: { currency: P2pCurrency | null; token: P2pToken | null } | null,
): string | null {
  return live?.currency && live.token
    ? estimateAmountOut(amount, live.currency.price, live.token.priceUsd, 'buy')
    : null;
}

/** How a paid request was paid, as stored; null for anything else. */
function paidMethodOf(stored: string | null): PaymentRequestMethod | null {
  return stored === 'transfer' || stored === 'p2p' ? stored : null;
}
