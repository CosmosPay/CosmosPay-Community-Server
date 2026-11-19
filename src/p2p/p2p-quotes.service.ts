import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import type { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import type { CreateP2pMarketQuoteDto } from '@/p2p/dto/p2p-order.dto';
import type { P2pMarketQuoteEntity } from '@/p2p/entities/p2p-offer.entity';
import { P2pAccountsService } from '@/p2p/p2p-accounts.service';
import { P2pMarketReader } from '@/p2p/p2p-market-reader.service';
import {
  hasLiquidity,
  offerRefusal,
  rankOffers,
  withinLimits,
  type P2pOfferCandidate,
} from '@/p2p/p2p-matching';
import type { P2pToken } from '@/p2p/p2p-networks';
import {
  P2pNetworksService,
  type P2pDeployment,
} from '@/p2p/p2p-networks.service';
import { P2P_LIVE_STATUSES } from '@/p2p/p2p-order-status';
import { P2pPaymentMethodsService } from '@/p2p/p2p-payment-methods.service';
import {
  bondFor,
  formatUnits,
  parseDecimalUnits,
  priceTrade,
  type P2pPricedAmounts,
  type P2pTradeSide,
} from '@/p2p/p2p-pricing';
import { P2P_RAILS, isP2pRailId } from '@/p2p/p2p-rails';
import { merchantStats } from '@/p2p/p2p-views';
import {
  P2P_BUY_PAYMENT_WINDOW_SECONDS,
  P2P_CURRENCIES,
  P2P_MATCH_MAX_CANDIDATES,
  P2P_PRICE_DECIMALS,
  P2P_QUOTE_TTL_SECONDS,
  P2P_SELL_ACCEPT_WINDOW_SECONDS,
  P2P_SELL_BOND_BPS,
  P2P_SELL_PAYMENT_WINDOW_SECONDS,
  P2P_SELL_SETTLE_WINDOW_SECONDS,
  type P2pCurrency,
} from '@/p2p/p2p.constants';

/** Offers loaded per match before the pure filters; more is a market this service does not serve yet. */
const OFFERS_PER_MATCH = 200;

/** What one match asks. */
export interface P2pMatchInput {
  deployment: P2pDeployment;
  token: P2pToken;
  side: P2pTradeSide;
  currency: string;
  rail: string;
  fiatUnits?: bigint;
  tokenUnits?: bigint;
  protocolFeeBps: number;
  integratorFeeBps: number;
  /** The other party's address: a merchant account at it is never matched (the contract refuses seller = buyer). */
  counterparty?: string;
}

/** The merchant that takes a trade, and the trade at its price. */
export interface P2pMatch {
  offerId: string;
  offerSnapshot: Record<string, unknown>;
  account: {
    id: string;
    consumerId: string;
    address: string;
    displayName: string;
    completedOrders: number;
    cancelledOrders: number;
    disputesLost: number;
    medianReleaseSeconds: number | null;
  };
  price: string;
  amounts: P2pPricedAmounts;
  bond: bigint;
  /** Purchases: the merchant's account the person pays. */
  paymentMethodId: string | null;
}

/** The windows an order of each side gets. */
export function windowsFor(side: P2pTradeSide) {
  return side === 'BUY'
    ? {
        acceptWindow: 0,
        paymentWindow: P2P_BUY_PAYMENT_WINDOW_SECONDS,
        settleWindow: 0,
      }
    : {
        acceptWindow: P2P_SELL_ACCEPT_WINDOW_SECONDS,
        paymentWindow: P2P_SELL_PAYMENT_WINDOW_SECONDS,
        settleWindow: P2P_SELL_SETTLE_WINDOW_SECONDS,
      };
}

/** Local money in a currency's minor units, or a 400. */
export function fiatUnitsOf(currency: string, value: string): bigint {
  const decimals = P2P_CURRENCIES[currency as P2pCurrency].decimals;
  const units = parseDecimalUnits(value, decimals);
  if (units === null || units <= 0n) {
    throw ApiError.badRequest(ApiErrorCode.ValidationFailed, [
      `the amount must be greater than 0 with at most ${decimals} decimals in ${currency}`,
    ]);
  }
  return units;
}

/** A rail that pays in the currency, or a 400. */
export function checkRail(rail: string, currency: string): void {
  if (!isP2pRailId(rail) || P2P_RAILS[rail].currency !== currency) {
    throw ApiError.badRequest(ApiErrorCode.ValidationFailed, [
      `rail ${rail} does not pay in ${currency}`,
    ]);
  }
}

/**
 * Prices a trade and picks its merchant (`P2pQuotesService.match`), and keeps
 * the answer for a minute as a quote. The person never picks the merchant: the
 * database narrows the offers, `p2p-matching.ts` filters and ranks them, and
 * the chain has the last word on the best few (a merchant's free balance and
 * what it allows the matcher).
 */
@Injectable()
export class P2pQuotesService {
  private readonly logger = new Logger(P2pQuotesService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly accounts: P2pAccountsService,
    private readonly networks: P2pNetworksService,
    private readonly reader: P2pMarketReader,
    private readonly paymentMethods: P2pPaymentMethodsService,
  ) {}

  async create(
    consumer: GatewayConsumer,
    dto: CreateP2pMarketQuoteDto,
  ): Promise<P2pMarketQuoteEntity> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    if ((dto.fiatAmount === undefined) === (dto.tokenAmount === undefined)) {
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, [
        'give exactly one of fiatAmount or tokenAmount',
      ]);
    }
    checkRail(dto.rail, dto.currency);
    const deployment = await this.reader.requireLive(tier, dto.network);
    const token = this.networks.token(deployment, dto.token);
    const integratorFeeBps = dto.integratorFeeBps ?? 0;
    let integratorAddress: string | null = null;
    if (integratorFeeBps > 0) {
      const account = dto.integratorAccountId
        ? await this.accounts.owned(consumerId, tier, dto.integratorAccountId)
        : await this.accounts.soleAccount(
            consumerId,
            tier,
            'your fee is paid to',
          );
      integratorAddress = account.address;
    }
    const protocol = await this.openProtocol(deployment);
    const match = await this.match({
      deployment,
      token,
      side: dto.side,
      currency: dto.currency,
      rail: dto.rail,
      fiatUnits:
        dto.fiatAmount !== undefined
          ? fiatUnitsOf(dto.currency, dto.fiatAmount)
          : undefined,
      tokenUnits:
        dto.tokenAmount !== undefined ? BigInt(dto.tokenAmount) : undefined,
      protocolFeeBps: protocol.feeBps,
      integratorFeeBps,
    });
    if (!match) throw noMatch();
    const decimals = P2P_CURRENCIES[dto.currency as P2pCurrency].decimals;
    const row = await this.prisma.p2pQuote.create({
      data: {
        consumerId,
        tier,
        side: dto.side,
        network: deployment.network,
        token: token.address,
        currency: dto.currency,
        rail: dto.rail,
        offerId: match.offerId,
        merchantAccountId: match.account.id,
        price: match.price,
        fiatAmount: formatUnits(match.amounts.fiatUnits, decimals),
        tokenAmount: match.amounts.grossTokens.toString(),
        netAmount: match.amounts.netTokens.toString(),
        protocolFeeBps: protocol.feeBps,
        protocolFee: match.amounts.protocolFee.toString(),
        integratorFeeBps,
        integratorFee: match.amounts.integratorFee.toString(),
        integratorAddress,
        bond: match.bond.toString(),
        expiresAt: new Date(Date.now() + P2P_QUOTE_TTL_SECONDS * 1000),
      },
    });
    return {
      id: row.id,
      side: row.side,
      network: row.network,
      token: row.token,
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      currency: row.currency,
      rail: row.rail,
      price: row.price,
      fiatAmount: row.fiatAmount,
      tokenAmount: row.tokenAmount,
      netAmount: row.netAmount,
      protocolFeeBps: row.protocolFeeBps,
      protocolFee: row.protocolFee,
      integratorFeeBps: row.integratorFeeBps,
      integratorFee: row.integratorFee,
      bond: row.bond,
      windows: windowsFor(dto.side),
      merchant: {
        displayName: match.account.displayName,
        ...merchantStats(match.account),
      },
      expiresAt: row.expiresAt,
    };
  }

  /** The contract's fee, refusing a paused deployment: it takes no new orders. */
  async openProtocol(deployment: P2pDeployment): Promise<{ feeBps: number }> {
    const state = await this.reader.protocolState(deployment);
    if (state.paused) {
      throw ApiError.conflict(
        ApiErrorCode.P2pNoMatch,
        `The P2P market on ${deployment.name} is paused for new orders right now: try again later.`,
      );
    }
    return { feeBps: state.feeBps };
  }

  /**
   * The merchant that takes a trade right now, or null. A sale and a payout
   * (`SELL`) match merchants that BUY tokens and must lock a bond; a purchase
   * and a charge (`BUY`) match merchants that SELL them from their balance
   * through the matcher, and that hold an active payment method on the rail.
   */
  async match(input: P2pMatchInput): Promise<P2pMatch | null> {
    const { deployment, token, side } = input;
    const tier = deployment.tier;
    const offers = await this.prisma.p2pOffer.findMany({
      where: {
        tier,
        network: deployment.network,
        token: token.address,
        currency: input.currency,
        side: side === 'BUY' ? 'SELL_TOKEN' : 'BUY_TOKEN',
        active: true,
        rails: { has: input.rail },
        ...(input.counterparty
          ? { account: { address: { not: input.counterparty } } }
          : {}),
      },
      take: OFFERS_PER_MATCH,
      select: {
        id: true,
        price: true,
        priceUpdatedAt: true,
        priceTtlSeconds: true,
        minFiat: true,
        maxFiat: true,
        rails: true,
        account: {
          select: {
            id: true,
            consumerId: true,
            address: true,
            displayName: true,
            merchantStatus: true,
            completedOrders: true,
            cancelledOrders: true,
            disputesLost: true,
            medianReleaseSeconds: true,
          },
        },
      },
    });
    if (offers.length === 0) return null;
    const accountIds = [...new Set(offers.map((o) => o.account.id))];
    const [open, withMethod] = await Promise.all([
      this.prisma.p2pOrder.groupBy({
        by: ['merchantAccountId'],
        where: {
          merchantAccountId: { in: accountIds },
          status: { in: [...P2P_LIVE_STATUSES] },
        },
        _count: { _all: true },
      }),
      side === 'BUY'
        ? this.paymentMethods.accountsWithMethod(
            accountIds,
            input.rail,
            input.currency,
          )
        : Promise.resolve(new Set<string>()),
    ]);
    const openBy = new Map(
      open.map((g) => [g.merchantAccountId, g._count._all]),
    );
    const currencyDecimals =
      P2P_CURRENCIES[input.currency as P2pCurrency].decimals;
    const maxOpenOrders = this.config.get('p2p', {
      infer: true,
    }).merchantMaxOpenOrders;
    const now = new Date();

    type Priced = P2pOfferCandidate & {
      row: (typeof offers)[number];
      amounts: P2pPricedAmounts;
    };
    const priced: Priced[] = [];
    for (const offer of offers) {
      const priceUnits = parseDecimalUnits(offer.price, P2P_PRICE_DECIMALS);
      const minFiatUnits = parseDecimalUnits(offer.minFiat, currencyDecimals);
      const maxFiatUnits = parseDecimalUnits(offer.maxFiat, currencyDecimals);
      if (
        !offer.account.displayName ||
        !priceUnits ||
        minFiatUnits === null ||
        maxFiatUnits === null
      ) {
        continue;
      }
      const candidate: P2pOfferCandidate = {
        offerId: offer.id,
        accountId: offer.account.id,
        priceUnits,
        priceUpdatedAt: offer.priceUpdatedAt,
        priceTtlSeconds: offer.priceTtlSeconds,
        minFiatUnits,
        maxFiatUnits,
        rails: offer.rails,
        merchantStatus: offer.account.merchantStatus,
        openOrders: openBy.get(offer.account.id) ?? 0,
        hasPaymentMethod: withMethod.has(offer.account.id),
        completed: offer.account.completedOrders,
        cancelled: offer.account.cancelledOrders,
        disputesLost: offer.account.disputesLost,
        medianReleaseSeconds: offer.account.medianReleaseSeconds,
      };
      if (
        offerRefusal(candidate, { side, rail: input.rail, now, maxOpenOrders })
      ) {
        continue;
      }
      const amounts = priceTrade({
        side,
        priceUnits,
        tokenDecimals: token.decimals,
        currencyDecimals,
        protocolFeeBps: input.protocolFeeBps,
        integratorFeeBps: input.integratorFeeBps,
        fiatUnits: input.fiatUnits,
        tokenUnits: input.tokenUnits,
      });
      if (!amounts || !withinLimits(candidate, amounts.fiatUnits)) continue;
      if (
        side === 'SELL' &&
        bondFor(amounts.grossTokens, P2P_SELL_BOND_BPS) === 0n
      ) {
        continue;
      }
      priced.push({ ...candidate, row: offer, amounts });
    }

    const matcher = this.networks.matcherAddress();
    for (const candidate of rankOffers(priced, side).slice(
      0,
      P2P_MATCH_MAX_CANDIDATES,
    )) {
      const bond =
        side === 'SELL'
          ? bondFor(candidate.amounts.grossTokens, P2P_SELL_BOND_BPS)
          : 0n;
      try {
        const [freeBalance, terms] = await Promise.all([
          this.reader.balanceOf(
            deployment,
            candidate.row.account.address,
            token.address,
          ),
          side === 'BUY' && matcher
            ? this.reader.matcherTerms(
                deployment,
                candidate.row.account.address,
                matcher,
              )
            : Promise.resolve({ maxPerOrder: 0n, autoSettle: false }),
        ]);
        if (side === 'BUY' && !matcher) return null;
        if (
          !hasLiquidity(
            side,
            { freeBalance, maxPerOrder: terms.maxPerOrder },
            candidate.amounts.grossTokens,
            bond,
          )
        ) {
          continue;
        }
      } catch (err) {
        this.logger.warn(
          `P2P match on ${deployment.network}/${tier}: merchant ${candidate.accountId} not read: ${String(err)}`,
        );
        continue;
      }
      const paymentMethod =
        side === 'BUY'
          ? await this.paymentMethods.activeFor(
              candidate.accountId,
              input.rail,
              input.currency,
            )
          : null;
      if (side === 'BUY' && !paymentMethod) continue;
      const account = candidate.row.account;
      return {
        offerId: candidate.offerId,
        offerSnapshot: {
          price: candidate.row.price,
          minFiat: candidate.row.minFiat,
          maxFiat: candidate.row.maxFiat,
          rails: candidate.row.rails,
          priceUpdatedAt: candidate.row.priceUpdatedAt.toISOString(),
        },
        account: {
          id: account.id,
          consumerId: account.consumerId,
          address: account.address,
          displayName: account.displayName as string,
          completedOrders: account.completedOrders,
          cancelledOrders: account.cancelledOrders,
          disputesLost: account.disputesLost,
          medianReleaseSeconds: account.medianReleaseSeconds,
        },
        price: candidate.row.price,
        amounts: candidate.amounts,
        bond,
        paymentMethodId: paymentMethod?.id ?? null,
      };
    }
    return null;
  }
}

export function noMatch(): ApiError {
  return ApiError.conflict(
    ApiErrorCode.P2pNoMatch,
    'No merchant can take this trade right now: try another amount, rail or network, or try again shortly.',
  );
}
