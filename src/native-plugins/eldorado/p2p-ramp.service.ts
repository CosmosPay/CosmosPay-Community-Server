import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toChecksumAddress } from '@/chains/chain-address';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { page } from '@/common/pagination';
import { PublicRecordTokens } from '@/common/public-record-token';
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
  ELDORADO_TOKENS_TTL_MS,
  P2P_MARKETPLACE,
} from '@/native-plugins/eldorado/eldorado.constants';
import {
  buildCurrencies,
  buildNetworks,
  chainProblem,
  estimateAmountOut,
  findToken,
  orderProblem,
  positiveDecimal,
  readChainIds,
  readTokens,
  searchTokens,
  sessionReference,
  widgetUrl,
  type P2pCurrency,
  type P2pMarket,
  type P2pNetwork,
  type P2pOrder,
  type P2pSide,
  type P2pToken,
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

/** A tokens query once its fields have passed the DTO. */
export interface P2pTokensQuery {
  chainId: number;
  q?: string;
  take: number;
  skip: number;
}

/**
 * One network's market as read together: both sides' currencies, the networks
 * whose token list loaded, and those lists (by chain id) for the orders and the
 * tokens route of the same minute.
 */
interface NetworkMarket {
  currencies: Record<P2pSide, P2pCurrency[]>;
  networks: P2pNetwork[];
  lists: ReadonlyMap<number, readonly P2pToken[]>;
}

interface CachedMarket {
  at: number;
  market: NetworkMarket;
}

interface CachedTokens {
  at: number;
  tokens: P2pToken[];
}

/**
 * Trading stablecoins for local money with P2P counterparts: purchases
 * (`/v1/onramp/p2p`, side `buy`) and sales (`/v1/offramp/p2p`, side `sell`).
 *
 * This service never holds the money: the person pays or is paid by a P2P
 * counterpart on the marketplace, which moves the token. What it owns is the
 * market read (both sides and the chain list cached per network for a minute,
 * each chain's token list for an hour), the firm quote (with the deployment's
 * integrator ids) and the consumer's record of each order it opened, with the
 * widget URL that takes it.
 *
 * The shared public key (a wallet with no account) may quote, open a session
 * and read that one session back with its record token (`publicToken`, sent
 * as `X-Record-Token`); it never lists sessions, since every anonymous wallet
 * is that one consumer. Its quotes and orders carry the public referral id
 * when the deployment sets one ({@link EldoradoClient.integratorIds}).
 */
@Injectable()
export class P2pRampService {
  private readonly logger = new Logger(P2pRampService.name);
  private readonly markets = new Map<StellarNetwork, CachedMarket>();
  private readonly inFlight = new Map<StellarNetwork, Promise<NetworkMarket>>();
  private readonly tokenLists = new Map<string, CachedTokens>();
  private readonly tokensInFlight = new Map<string, Promise<P2pToken[]>>();

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly client: EldoradoClient,
    private readonly recordTokens: PublicRecordTokens,
  ) {}

  /** One side of the market on the key's network, at most {@link ELDORADO_MARKET_TTL_MS} old. */
  async market(consumer: GatewayConsumer, side: P2pSide): Promise<P2pMarket> {
    const network = resolveNetwork(this.config, consumer);
    return sideOf(await this.marketOn(network), side, network);
  }

  /**
   * A page of one chain's tokens on the key's network, searched by `q` (a
   * symbol fragment or an exact address), the network's main assets first. A chain the
   * market does not offer right now is a 400.
   */
  async tokens(consumer: GatewayConsumer, query: P2pTokensQuery) {
    const network = resolveNetwork(this.config, consumer);
    const state = await this.marketOn(network);
    const problem = chainProblem(sideOf(state, 'buy', network), query.chainId);
    if (problem)
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, problem);
    const found = searchTokens(state.lists.get(query.chainId) ?? [], query.q);
    return page(
      found.slice(query.skip, query.skip + query.take),
      found.length,
      query,
    );
  }

  /** A firm quote for `order` on `side`, from the marketplace. Nothing is stored. */
  async quote(consumer: GatewayConsumer, side: P2pSide, order: P2pOrder) {
    const network = resolveNetwork(this.config, consumer);
    const { token } = this.checkOrder(
      await this.marketOn(network),
      network,
      order,
      side,
    );
    const address = toChecksumAddress(order.address);
    const common = {
      token: token.address,
      chainId: String(token.chainId),
      fiatCurrencyId: order.currency,
      paymentMethodId: order.paymentMethod,
      amount: order.amount,
      fixedAmountSide: 'IN' as const,
    };
    const shared = this.recordTokens.isSharedPublicKey(consumer);
    const raw = await this.upstream(() =>
      side === 'buy'
        ? this.client.buyQuote(
            network,
            { ...common, addressTo: address },
            shared,
          )
        : this.client.sellQuote(
            network,
            { ...common, addressFrom: address },
            shared,
          ),
    );
    return toQuote(raw, order, token);
  }

  /**
   * Records an order on `side` and answers the widget URL that takes it. A
   * purchase fixes `order.address` as the recipient there; a sale records it as
   * the account the stablecoin comes from, and the seller connects that wallet
   * in the widget. The order is checked against the market first, so a session
   * never opens a widget the marketplace refuses. The shared public key gets
   * the session's `publicToken`, its only way to read it back.
   */
  async createSession(
    consumer: GatewayConsumer,
    side: P2pSide,
    order: P2pOrder,
  ) {
    const network = resolveNetwork(this.config, consumer);
    const { currency, token } = this.checkOrder(
      await this.marketOn(network),
      network,
      order,
      side,
    );
    const address = toChecksumAddress(order.address);
    const reference = sessionReference(randomUUID());
    const local = await this.consumers.resolve(consumer);
    const row = await this.prisma.p2pRampSession.create({
      data: {
        consumerId: local.id,
        network,
        side,
        currency: currency.id,
        paymentMethod: order.paymentMethod,
        amount: order.amount,
        token: token.symbol,
        tokenAddress: token.address,
        chainId: token.chainId,
        address,
        estimatedAmountOut: estimateAmountOut(
          order.amount,
          currency.price,
          token.priceUsd,
          side,
        ),
        reference,
        widgetUrl: widgetUrl(
          ELDORADO_HOSTS[network],
          { ...order, address },
          token,
          reference,
          this.client.integratorIds(
            this.recordTokens.isSharedPublicKey(consumer),
          ),
          side,
        ),
      },
      select: P2P_SESSION_PUBLIC_SELECT,
    });
    return this.recordTokens.attach(consumer, 'p2p-ramp-session', row);
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
   * or one of the other side, is the 404 of a missing one. The shared public
   * key also needs the session's record token: a missing or wrong one is the
   * same 404, decided before the table is read.
   */
  async findOne(
    consumer: GatewayConsumer,
    side: P2pSide,
    id: string,
    recordToken?: string,
  ) {
    if (
      !this.recordTokens.admits(consumer, 'p2p-ramp-session', id, recordToken)
    ) {
      throw ApiError.notFound(SESSION_NOT_FOUND[side]);
    }
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

  /**
   * The order's currency and token once the market takes it; a 400 with the
   * reason otherwise, so a session never opens a widget the marketplace refuses.
   */
  private checkOrder(
    state: NetworkMarket,
    network: StellarNetwork,
    order: P2pOrder,
    side: P2pSide,
  ): { currency: P2pCurrency; token: P2pToken } {
    const market = sideOf(state, side, network);
    const tokens = state.lists.get(order.chainId) ?? null;
    const problem = orderProblem(market, tokens, order, side);
    if (problem)
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, problem);
    return {
      currency: market.currencies.find((c) => c.id === order.currency)!,
      token: findToken(tokens!, order.token)!,
    };
  }

  private marketOn(network: StellarNetwork): Promise<NetworkMarket> {
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

  /**
   * Both sides and the networks from one read. A side `/prices` leaves out (or
   * sends unreadable) offers nothing; with neither side, without the currency
   * and payment method lists, or without the chain list, the answer is
   * unusable: a 502. A chain whose token list fails or is empty is left out of
   * the networks (and asked again on the next read); only when every list does
   * is the market a 502.
   */
  private async readMarket(network: StellarNetwork): Promise<NetworkMarket> {
    const [currencies, methods, prices, chains] = await this.upstream(() =>
      Promise.all([
        this.client.currencies(network),
        this.client.paymentMethods(network),
        this.client.prices(network),
        this.client.chains(network),
      ]),
    );
    const buy = priceSide(prices?.BUY);
    const sell = priceSide(prices?.SELL);
    const chainIds = readChainIds(chains?.chains);
    if (
      !Array.isArray(currencies?.currencies) ||
      !Array.isArray(methods?.paymentMethods) ||
      (!buy && !sell) ||
      chainIds.length === 0
    ) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `The ${P2P_MARKETPLACE} answered a market this service cannot read.`,
      );
    }
    const lists = await this.tokenListsOn(network, chainIds);
    const list = currencies.currencies;
    const ways = methods.paymentMethods;
    return {
      currencies: {
        buy: buildCurrencies(list, ways, buy),
        sell: buildCurrencies(list, ways, sell),
      },
      networks: buildNetworks(
        lists,
        ELDORADO_HOSTS[network].defaultToken.chainId,
      ),
      lists,
    };
  }

  /** Every chain's token list that loads with a token in it; a 502 when none does. */
  private async tokenListsOn(
    network: StellarNetwork,
    chainIds: number[],
  ): Promise<Map<number, P2pToken[]>> {
    const read = await Promise.allSettled(
      chainIds.map((chainId) => this.tokensOn(network, chainId)),
    );
    const lists = new Map<number, P2pToken[]>();
    read.forEach((result, at) => {
      const chainId = chainIds[at];
      if (result.status === 'fulfilled' && result.value.length > 0) {
        lists.set(chainId, result.value);
        return;
      }
      const why =
        result.status === 'rejected'
          ? result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
          : 'no token it can read';
      this.logger.warn(
        `The ${P2P_MARKETPLACE} token list of chain ${chainId} (${network}) is left out: ${why}`,
      );
    });
    if (lists.size === 0) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `The ${P2P_MARKETPLACE} answered no token list this service can read.`,
      );
    }
    return lists;
  }

  /**
   * One chain's tokens, at most {@link ELDORADO_TOKENS_TTL_MS} old. Only a list
   * with tokens is kept: a failure or an empty answer is asked again next time.
   */
  private tokensOn(
    network: StellarNetwork,
    chainId: number,
  ): Promise<P2pToken[]> {
    const key = `${network}:${chainId}`;
    const cached = this.tokenLists.get(key);
    if (cached && Date.now() - cached.at < ELDORADO_TOKENS_TTL_MS) {
      return Promise.resolve(cached.tokens);
    }
    const running = this.tokensInFlight.get(key);
    if (running) return running;
    const read = this.upstream(() => this.client.tokens(network, chainId))
      .then((answer) => {
        const tokens = readTokens(answer?.tokens, chainId);
        if (tokens.length > 0)
          this.tokenLists.set(key, { at: Date.now(), tokens });
        return tokens;
      })
      .finally(() => this.tokensInFlight.delete(key));
    this.tokensInFlight.set(key, read);
    return read;
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

/** One side of a network's market, as `GET .../market` answers it. */
function sideOf(
  state: NetworkMarket,
  side: P2pSide,
  network: StellarNetwork,
): P2pMarket {
  return {
    currencies: state.currencies[side],
    networks: state.networks,
    defaultToken: ELDORADO_HOSTS[network].defaultToken,
  };
}

/** The marketplace's quote as this API publishes it; one it cannot read is a 502. */
function toQuote(raw: RawQuote, order: P2pOrder, token: P2pToken) {
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
    token: token.symbol,
    tokenAddress: token.address,
    chainId: token.chainId,
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
