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
  type RawBuyQuote,
} from '@/native-plugins/eldorado/eldorado.client';
import {
  ELDORADO_HOSTS,
  ELDORADO_MARKET_TTL_MS,
  P2P_MARKETPLACE,
} from '@/native-plugins/eldorado/eldorado.constants';
import {
  buildMarket,
  estimateAmountOut,
  orderProblem,
  positiveDecimal,
  sessionReference,
  widgetUrl,
  type P2pMarket,
  type P2pOrder,
} from '@/native-plugins/eldorado/p2p-market';
import { PrismaService } from '@/prisma/prisma.service';

/** What a session read answers: every column but the consumer. */
const P2P_SESSION_PUBLIC_SELECT = {
  id: true,
  network: true,
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

interface CachedMarket {
  at: number;
  market: P2pMarket;
}

/**
 * Buying stablecoins with local money from P2P sellers (`/v1/onramp/p2p`).
 *
 * This service never holds the money: the buyer pays a seller on the
 * marketplace, which delivers the stablecoin to the address the session fixed.
 * What it owns is the market read (cached per network), the firm quote (with
 * the deployment's integrator ids) and the consumer's record of each purchase
 * it opened, with the widget URL that takes it.
 */
@Injectable()
export class P2pOnrampService {
  private readonly markets = new Map<StellarNetwork, CachedMarket>();
  private readonly inFlight = new Map<StellarNetwork, Promise<P2pMarket>>();

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly client: EldoradoClient,
  ) {}

  /** The market on the key's network, at most {@link ELDORADO_MARKET_TTL_MS} old. */
  market(consumer: GatewayConsumer): Promise<P2pMarket> {
    return this.marketOn(resolveNetwork(this.config, consumer));
  }

  /** A firm quote for `order`, from the marketplace. Nothing is stored. */
  async quote(consumer: GatewayConsumer, order: P2pOrder) {
    const network = resolveNetwork(this.config, consumer);
    const market = await this.marketOn(network);
    this.assertOrder(market, order);
    const host = ELDORADO_HOSTS[network];
    const token = host.tokens.find((t) => t.symbol === order.token)!;
    const raw = await this.upstream(() =>
      this.client.buyQuote(network, {
        addressTo: toChecksumAddress(order.address),
        token: token.address,
        chainId: String(host.chainId),
        fiatCurrencyId: order.currency,
        paymentMethodId: order.paymentMethod,
        amount: order.amount,
        fixedAmountSide: 'IN',
      }),
    );
    return toQuote(raw, order, host.chainId);
  }

  /**
   * Records a purchase and answers the widget URL that takes it, with
   * `order.address` fixed as the recipient. The order is checked against the
   * market first, so a session never opens a widget the marketplace refuses.
   */
  async createSession(consumer: GatewayConsumer, order: P2pOrder) {
    const network = resolveNetwork(this.config, consumer);
    const market = await this.marketOn(network);
    this.assertOrder(market, order);
    const host = ELDORADO_HOSTS[network];
    const token = host.tokens.find((t) => t.symbol === order.token)!;
    const currency = market.currencies.find((c) => c.id === order.currency)!;
    const address = toChecksumAddress(order.address);
    const reference = sessionReference(randomUUID());
    const local = await this.consumers.resolve(consumer);
    return this.prisma.onrampP2pSession.create({
      data: {
        consumerId: local.id,
        network,
        currency: currency.id,
        paymentMethod: order.paymentMethod,
        amount: order.amount,
        token: token.symbol,
        tokenAddress: token.address,
        chainId: host.chainId,
        address,
        estimatedAmountOut: estimateAmountOut(order.amount, currency.price),
        reference,
        widgetUrl: widgetUrl(
          host,
          { ...order, address },
          reference,
          this.client.integratorIds(),
        ),
      },
      select: P2P_SESSION_PUBLIC_SELECT,
    });
  }

  /** The consumer's sessions on the key's network, newest first. */
  async findAll(consumer: GatewayConsumer, query: PaginationQueryDto) {
    const consumerId = await this.consumers.resolveId(consumer);
    const where = {
      consumerId,
      network: resolveNetwork(this.config, consumer),
    };
    const [data, total] = await Promise.all([
      this.prisma.onrampP2pSession.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: P2P_SESSION_PUBLIC_SELECT,
      }),
      this.prisma.onrampP2pSession.count({ where }),
    ]);
    return page(data, total, query);
  }

  /** One session of the consumer on the key's network; anyone else's is the 404 of a missing one. */
  async findOne(consumer: GatewayConsumer, id: string) {
    const consumerId = await this.consumers.resolveId(consumer);
    const row = await this.prisma.onrampP2pSession.findFirst({
      where: { id, consumerId, network: resolveNetwork(this.config, consumer) },
      select: P2P_SESSION_PUBLIC_SELECT,
    });
    if (!row) throw ApiError.notFound('P2P on-ramp session not found');
    return row;
  }

  private assertOrder(market: P2pMarket, order: P2pOrder): void {
    const problem = orderProblem(market, order);
    if (problem)
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, problem);
  }

  private marketOn(network: StellarNetwork): Promise<P2pMarket> {
    const cached = this.markets.get(network);
    if (cached && Date.now() - cached.at < ELDORADO_MARKET_TTL_MS) {
      return Promise.resolve(cached.market);
    }
    const running = this.inFlight.get(network);
    if (running) return running;
    const read = this.readMarket(network)
      .then((market) => {
        this.markets.set(network, { at: Date.now(), market });
        return market;
      })
      .finally(() => this.inFlight.delete(network));
    this.inFlight.set(network, read);
    return read;
  }

  private async readMarket(network: StellarNetwork): Promise<P2pMarket> {
    const [currencies, methods, prices] = await this.upstream(() =>
      Promise.all([
        this.client.currencies(network),
        this.client.paymentMethods(network),
        this.client.prices(network),
      ]),
    );
    if (
      !Array.isArray(currencies?.currencies) ||
      !Array.isArray(methods?.paymentMethods) ||
      !prices?.BUY ||
      typeof prices.BUY !== 'object'
    ) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `The ${P2P_MARKETPLACE} answered a market this service cannot read.`,
      );
    }
    return buildMarket(
      ELDORADO_HOSTS[network],
      currencies.currencies,
      methods.paymentMethods,
      prices.BUY,
    );
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

/** The marketplace's quote as this API publishes it; one it cannot read is a 502. */
function toQuote(raw: RawBuyQuote, order: P2pOrder, chainId: number) {
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
