import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toChecksumAddress } from '@/chains/chain-address';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { page } from '@/common/pagination';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { resolveNetwork } from '@/common/stellar-network';
import { UpstreamNotFound } from '@/common/upstream-http';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import type { PaginationQueryDto } from '@/common/dto/pagination.query.dto';
import {
  EldoradoClient,
  type RawQuote,
} from '@/native-plugins/eldorado/eldorado.client';
import {
  ELDORADO_HOSTS,
  ELDORADO_MARKET_TTL_MS,
  P2P_MARKETPLACE,
  type EldoradoHost,
  type EldoradoToken,
} from '@/native-plugins/eldorado/eldorado.constants';
import {
  buildMarket,
  estimateAmountOut,
  orderProblem,
  positiveDecimal,
  sessionReference,
  widgetUrl,
  type P2pMarket,
  type P2pMarkets,
  type P2pOrder,
  type P2pSide,
} from '@/native-plugins/eldorado/p2p-market';
import { PrismaService } from '@/prisma/prisma.service';

/** What a session read answers: every column but the consumer. */
const P2P_SESSION_PUBLIC_SELECT = {
  id: true,
  network: true,
  side: true,
  currency: true,
  paymentMethod: true,
  amount: true,
  token: true,
  tokenAddress: true,
  chainId: true,
  address: true,
  estimatedAmountOut: true,
  reference: true,
  widgetUrl: true,
  createdAt: true,
} as const;

/** The 404 of a session the caller cannot read, per side. */
const SESSION_NOT_FOUND: Record<P2pSide, string> = {
  buy: 'P2P on-ramp session not found',
  sell: 'P2P off-ramp session not found',
};

interface CachedMarkets {
  at: number;
  markets: P2pMarkets;
}

/**
 * Trading stablecoins for local money with P2P counterparts: purchases
 * (`/v1/onramp/p2p`, side `buy`) and sales (`/v1/offramp/p2p`, side `sell`).
 *
 * This service never holds the money: the person pays or is paid by a P2P
 * counterpart on the marketplace, which moves the stablecoin. What it owns is
 * the market read (both sides cached per network), the firm quote (with the
 * deployment's integrator ids) and the consumer's record of each order it
 * opened, with the widget URL that takes it.
 */
@Injectable()
export class P2pRampService {
  private readonly markets = new Map<StellarNetwork, CachedMarkets>();
  private readonly inFlight = new Map<StellarNetwork, Promise<P2pMarkets>>();

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly client: EldoradoClient,
  ) {}

  /** One side of the market on the key's network, at most {@link ELDORADO_MARKET_TTL_MS} old. */
  async market(consumer: GatewayConsumer, side: P2pSide): Promise<P2pMarket> {
    const markets = await this.marketsOn(resolveNetwork(this.config, consumer));
    return markets[side];
  }

  /** A firm quote for `order` on `side`, from the marketplace. Nothing is stored. */
  async quote(consumer: GatewayConsumer, side: P2pSide, order: P2pOrder) {
    const network = resolveNetwork(this.config, consumer);
    const market = (await this.marketsOn(network))[side];
    this.assertOrder(market, order, side);
    const host = ELDORADO_HOSTS[network];
    const token = tokenOf(host, order);
    const address = toChecksumAddress(order.address);
    const common = {
      token: token.address,
      chainId: String(host.chainId),
      fiatCurrencyId: order.currency,
      paymentMethodId: order.paymentMethod,
      amount: order.amount,
      fixedAmountSide: 'IN' as const,
    };
    const raw = await this.upstream(() =>
      side === 'buy'
        ? this.client.buyQuote(network, { ...common, addressTo: address })
        : this.client.sellQuote(network, { ...common, addressFrom: address }),
    );
    return toQuote(raw, order, host.chainId);
  }

  /**
   * Records an order on `side` and answers the widget URL that takes it. A
   * purchase fixes `order.address` as the recipient there; a sale records it as
   * the account the stablecoin comes from, and the seller connects that wallet
   * in the widget. The order is checked against the market first, so a session
   * never opens a widget the marketplace refuses.
   */
  async createSession(
    consumer: GatewayConsumer,
    side: P2pSide,
    order: P2pOrder,
  ) {
    const network = resolveNetwork(this.config, consumer);
    const market = (await this.marketsOn(network))[side];
    this.assertOrder(market, order, side);
    const host = ELDORADO_HOSTS[network];
    const token = tokenOf(host, order);
    const currency = market.currencies.find((c) => c.id === order.currency)!;
    const address = toChecksumAddress(order.address);
    const reference = sessionReference(randomUUID());
    const local = await this.consumers.resolve(consumer);
    return this.prisma.p2pRampSession.create({
      data: {
        consumerId: local.id,
        network,
        side,
        currency: currency.id,
        paymentMethod: order.paymentMethod,
        amount: order.amount,
        token: token.symbol,
        tokenAddress: token.address,
        chainId: host.chainId,
        address,
        estimatedAmountOut: estimateAmountOut(
          order.amount,
          currency.price,
          side,
        ),
        reference,
        widgetUrl: widgetUrl(
          host,
          { ...order, address },
          reference,
          this.client.integratorIds(),
          side,
        ),
      },
      select: P2P_SESSION_PUBLIC_SELECT,
    });
  }

  /** The consumer's sessions of `side` on the key's network, newest first. */
  async findAll(
    consumer: GatewayConsumer,
    side: P2pSide,
    query: PaginationQueryDto,
  ) {
    const consumerId = await this.consumers.resolveId(consumer);
    const where = {
      consumerId,
      network: resolveNetwork(this.config, consumer),
      side,
    };
    const [data, total] = await Promise.all([
      this.prisma.p2pRampSession.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: P2P_SESSION_PUBLIC_SELECT,
      }),
      this.prisma.p2pRampSession.count({ where }),
    ]);
    return page(data, total, query);
  }

  /**
   * One session of the consumer on the key's network and `side`; anyone else's,
   * or one of the other side, is the 404 of a missing one.
   */
  async findOne(consumer: GatewayConsumer, side: P2pSide, id: string) {
    const consumerId = await this.consumers.resolveId(consumer);
    const row = await this.prisma.p2pRampSession.findFirst({
      where: {
        id,
        consumerId,
        network: resolveNetwork(this.config, consumer),
        side,
      },
      select: P2P_SESSION_PUBLIC_SELECT,
    });
    if (!row) throw ApiError.notFound(SESSION_NOT_FOUND[side]);
    return row;
  }

  private assertOrder(market: P2pMarket, order: P2pOrder, side: P2pSide) {
    const problem = orderProblem(market, order, side);
    if (problem)
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, problem);
  }

  private marketsOn(network: StellarNetwork): Promise<P2pMarkets> {
    const cached = this.markets.get(network);
    if (cached && Date.now() - cached.at < ELDORADO_MARKET_TTL_MS) {
      return Promise.resolve(cached.markets);
    }
    const running = this.inFlight.get(network);
    if (running) return running;
    const read = this.readMarkets(network)
      .then((markets) => {
        this.markets.set(network, { at: Date.now(), markets });
        return markets;
      })
      .finally(() => this.inFlight.delete(network));
    this.inFlight.set(network, read);
    return read;
  }

  /**
   * Both sides from one read of the three lists. A side `/prices` leaves out
   * (or sends unreadable) offers nothing; with neither side, or without the
   * currency and payment method lists, the answer is unusable: a 502.
   */
  private async readMarkets(network: StellarNetwork): Promise<P2pMarkets> {
    const [currencies, methods, prices] = await this.upstream(() =>
      Promise.all([
        this.client.currencies(network),
        this.client.paymentMethods(network),
        this.client.prices(network),
      ]),
    );
    const buy = priceSide(prices?.BUY);
    const sell = priceSide(prices?.SELL);
    if (
      !Array.isArray(currencies?.currencies) ||
      !Array.isArray(methods?.paymentMethods) ||
      (!buy && !sell)
    ) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `The ${P2P_MARKETPLACE} answered a market this service cannot read.`,
      );
    }
    const host = ELDORADO_HOSTS[network];
    const list = currencies.currencies;
    const ways = methods.paymentMethods;
    return {
      buy: buildMarket(host, list, ways, buy),
      sell: buildMarket(host, list, ways, sell),
    };
  }

  /** A 404 from the marketplace is its fault here (every path is fixed): a 502. */
  private async upstream<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof UpstreamNotFound) {
        throw ApiError.badGateway(
          ApiErrorCode.ProviderError,
          `The ${P2P_MARKETPLACE} answered 404 for a path it serves.`,
        );
      }
      throw error;
    }
  }
}

/** A side of `/prices` when it is an object, else null. */
function priceSide<T>(raw: T | undefined): T | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

/** The order's token on `host`; `orderProblem` has already checked it is listed. */
function tokenOf(host: EldoradoHost, order: P2pOrder): EldoradoToken {
  return host.tokens.find((t) => t.symbol === order.token)!;
}

/** The marketplace's quote as this API publishes it; one it cannot read is a 502. */
function toQuote(raw: RawQuote, order: P2pOrder, chainId: number) {
  const amountIn = positiveDecimal(raw.amountIn);
  const amountOut = positiveDecimal(raw.amountOut);
  const minAmountOut = positiveDecimal(raw.minAmountOut);
  const exchangeRate = positiveDecimal(raw.exchangeRate);
  const feeToken = decimalOrZero(raw.fee?.amountInToken);
  const feeFiat = decimalOrZero(raw.fee?.amountInFiat);
  const quoteId =
    typeof raw.quoteId === 'string' && raw.quoteId ? raw.quoteId : null;
  const expiresAt =
    typeof raw.expiresAt === 'string' &&
    !Number.isNaN(Date.parse(raw.expiresAt))
      ? raw.expiresAt
      : null;
  if (
    !amountIn ||
    !amountOut ||
    !minAmountOut ||
    !exchangeRate ||
    feeToken === null ||
    feeFiat === null ||
    !quoteId ||
    !expiresAt
  ) {
    throw ApiError.badGateway(
      ApiErrorCode.ProviderError,
      `The ${P2P_MARKETPLACE} answered a quote this service cannot read.`,
    );
  }
  return {
    quoteId,
    currency: order.currency,
    token: order.token,
    chainId,
    amountIn,
    amountOut,
    minAmountOut,
    exchangeRate,
    fee: { amountInToken: feeToken, amountInFiat: feeFiat },
    expiresAt,
  };
}

/** A non-negative decimal, `0` included (a fee can be nothing), or null. */
function decimalOrZero(raw: unknown): string | null {
  const text =
    typeof raw === 'number'
      ? String(raw)
      : typeof raw === 'string'
        ? raw.trim()
        : '';
  return /^\d+(\.\d+)?$/.test(text) ? text : null;
}
