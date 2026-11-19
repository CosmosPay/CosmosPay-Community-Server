import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { paymentDepositClientSubject } from '@/payment-intents/payment-deposit-rules';
import { PrismaService } from '@/prisma/prisma.service';
import type { CreateP2pCheckoutOrderDto } from '@/p2p/dto/p2p-charge.dto';
import type { ReportP2pMarketPaidDto } from '@/p2p/dto/p2p-order.dto';
import type {
  P2pCheckoutChargeEntity,
  P2pCheckoutCreatedOrderEntity,
  P2pCheckoutOrderEntity,
} from '@/p2p/entities/p2p-charge.entity';
import { P2pMarketReader } from '@/p2p/p2p-market-reader.service';
import { P2pNetworksService } from '@/p2p/p2p-networks.service';
import { P2pOrderOpener } from '@/p2p/p2p-order-opener.service';
import { isUuid } from '@/p2p/p2p-order-ref';
import { P2P_LIVE_STATUSES } from '@/p2p/p2p-order-status';
import { P2pOrdersService } from '@/p2p/p2p-orders.service';
import { P2pPaymentMethodsService } from '@/p2p/p2p-payment-methods.service';
import {
  P2pQuotesService,
  checkRail,
  fiatUnitsOf,
  noMatch,
  windowsFor,
} from '@/p2p/p2p-quotes.service';
import { isDocumentNumber, isPersonName, railsFor } from '@/p2p/p2p-rails';
import {
  P2P_CHARGE_SELECT,
  P2P_ORDER_SELECT,
  chargeStatus,
  toCheckoutOrderView,
  type P2pChargeRow,
  type P2pOrderRow,
} from '@/p2p/p2p-views';
import {
  P2P_CHARGE_LOCK_CLASS,
  P2P_CHECKOUT_CHARGE_BUDGET,
  P2P_CHECKOUT_CHARGE_WINDOW_MS,
  P2P_CHECKOUT_CLIENT_KEY_LABEL,
  P2P_CHECKOUT_MAX_LIVE_PER_CLIENT,
  P2P_PAYER_TOKEN_BYTES,
} from '@/p2p/p2p.constants';

/** The charge's creation budget is spent: come back in `retryAfterSeconds`. */
export class P2pCheckoutBudgetError extends ApiError {
  constructor(readonly retryAfterSeconds: number) {
    super(
      429,
      ApiErrorCode.RateLimited,
      `Too many requests. Retry in ${retryAfterSeconds}s.`,
    );
  }
}

/** What a payer token is stored and looked up by: its SHA-256, hex. */
export function payerTokenHashOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * The payer's half of a charge, without an API key (`/v1/p2p-checkout/*`).
 *
 * The charge's uuid is the capability to READ it and to START paying it, and
 * every start costs the matcher's gas and locks a merchant's liquidity, so an
 * id alone is never unbounded spend: one live order per charge unless it is
 * multi-use, one live order per client address (an IPv6 caller by its /48,
 * stored as an HMAC) on it, and a refilling creation budget per charge (`429`
 * with `Retry-After`), all checked as ONE step under the charge's advisory
 * lock. The order then belongs to the charge's consumer and pays the charge's
 * recipient. Reading the order and reporting the payment take its payer token
 * (256 bits, handed out once, only its SHA-256 kept), never the id alone.
 */
@Injectable()
export class P2pCheckoutService {
  private readonly logger = new Logger(P2pCheckoutService.name);
  private clientSecret?: Buffer;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly networks: P2pNetworksService,
    private readonly reader: P2pMarketReader,
    private readonly quotes: P2pQuotesService,
    private readonly opener: P2pOrderOpener,
    private readonly orders: P2pOrdersService,
    private readonly paymentMethods: P2pPaymentMethodsService,
  ) {}

  private async charge(
    id: string,
  ): Promise<P2pChargeRow & { consumerId: string }> {
    const row = isUuid(id)
      ? await this.prisma.p2pCharge.findUnique({
          where: { id },
          select: { ...P2P_CHARGE_SELECT, consumerId: true },
        })
      : null;
    if (!row) throw ApiError.notFound(`P2P charge ${id} not found`);
    return row;
  }

  async getCharge(id: string): Promise<P2pCheckoutChargeEntity> {
    const row = await this.charge(id);
    const offered = await this.prisma.p2pOffer.findMany({
      where: {
        tier: row.tier,
        network: row.network,
        token: row.token,
        currency: row.currency,
        side: 'SELL_TOKEN',
        active: true,
        account: { merchantStatus: 'ACTIVE' },
      },
      select: { rails: true },
      take: 200,
    });
    const offeredRails = new Set(offered.flatMap((o) => o.rails));
    const d = this.networks.find(row.tier as StellarNetwork, row.network);
    return {
      id: row.id,
      network: row.network,
      tokenSymbol:
        d?.tokens.find((t) => t.address === row.token)?.symbol ?? row.token,
      currency: row.currency,
      fiatAmount: row.fiatAmount,
      merchantName: row.payeeName,
      description: row.description,
      status: chargeStatus(row, new Date()),
      rails: railsFor(row.currency).filter((r) => offeredRails.has(r)),
      expiresAt: row.expiresAt,
    };
  }

  private clientKey(ip: string): string {
    this.clientSecret ??= Buffer.from(
      hkdfSync(
        'sha256',
        this.config.get('apisix', { infer: true }).gatewaySecret,
        Buffer.alloc(0),
        P2P_CHECKOUT_CLIENT_KEY_LABEL,
        32,
      ),
    );
    return createHmac('sha256', this.clientSecret)
      .update(paymentDepositClientSubject(ip))
      .digest('base64url');
  }

  /**
   * Starts paying a charge: a purchase of its exact amount on the payer's
   * rail, matched and opened like any purchase, delivered to the charge's
   * recipient. `ip` is the caller's address (`clientIp(req)`).
   */
  async createOrder(
    chargeId: string,
    dto: CreateP2pCheckoutOrderDto,
    ip: string,
  ): Promise<P2pCheckoutCreatedOrderEntity> {
    const charge = await this.charge(chargeId);
    const now = new Date();
    if (chargeStatus(charge, now) !== 'open') {
      throw ApiError.conflict(
        ApiErrorCode.RequestClosed,
        `P2P charge ${chargeId} is ${chargeStatus(charge, now)}: it can no longer be paid`,
      );
    }
    checkRail(dto.rail, charge.currency);
    const errors: string[] = [];
    if (!isPersonName(dto.payer.name))
      errors.push('payer.name must be a person’s name');
    if (!isDocumentNumber(dto.payer.document)) {
      errors.push(
        'payer.document must be 4 to 20 letters, digits, dots or hyphens',
      );
    }
    if (errors.length)
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, errors);

    const tier = charge.tier as StellarNetwork;
    const deployment = await this.reader.requireLive(tier, charge.network);
    const token = this.networks.token(deployment, charge.token);
    const protocol = await this.quotes.openProtocol(deployment);
    const matcher = this.networks.matcherAddress();
    if (!matcher) throw noMatch();
    const clientKey = this.clientKey(ip);
    const payerToken = randomBytes(P2P_PAYER_TOKEN_BYTES).toString('base64url');

    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${P2P_CHARGE_LOCK_CLASS}::int, hashtext(${charge.id}))`;
        const live = {
          chargeId: charge.id,
          status: { in: [...P2P_LIVE_STATUSES] },
        };
        if (
          !charge.multiUse &&
          (await tx.p2pOrder.count({ where: live })) > 0
        ) {
          throw ApiError.conflict(
            ApiErrorCode.OperationInFlight,
            'Someone is paying this charge right now: try again when their order ends.',
          );
        }
        const mine = await tx.p2pOrder.count({ where: { ...live, clientKey } });
        if (mine >= P2P_CHECKOUT_MAX_LIVE_PER_CLIENT) {
          throw ApiError.conflict(
            ApiErrorCode.OperationInFlight,
            'You already have an order on this charge: finish or cancel it first.',
          );
        }
        const recent = await tx.p2pOrder.findMany({
          where: {
            chargeId: charge.id,
            createdAt: {
              gte: new Date(now.getTime() - P2P_CHECKOUT_CHARGE_WINDOW_MS),
            },
          },
          select: { createdAt: true },
          orderBy: { createdAt: 'asc' },
        });
        if (recent.length >= P2P_CHECKOUT_CHARGE_BUDGET) {
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil(
              (recent[0].createdAt.getTime() +
                P2P_CHECKOUT_CHARGE_WINDOW_MS -
                now.getTime()) /
                1000,
            ),
          );
          this.logger.warn(
            `P2P charge ${charge.id}: order creation budget spent; retry in ${retryAfterSeconds}s`,
          );
          throw new P2pCheckoutBudgetError(retryAfterSeconds);
        }
        const match = await this.quotes.match({
          deployment,
          token,
          side: 'BUY',
          currency: charge.currency,
          rail: dto.rail,
          fiatUnits: fiatUnitsOf(charge.currency, charge.fiatAmount),
          protocolFeeBps: protocol.feeBps,
          integratorFeeBps: 0,
          counterparty: charge.recipientAddress,
        });
        if (!match) throw noMatch();
        return this.opener.insert({
          id: randomUUID(),
          consumerId: charge.consumerId,
          kind: 'CHARGE',
          deployment,
          token,
          match,
          currency: charge.currency,
          rail: dto.rail,
          sellerAddress: match.account.address,
          buyerAddress: charge.recipientAddress,
          openerAddress: matcher,
          windows: windowsFor('BUY'),
          protocolFeeBps: protocol.feeBps,
          integratorFeeBps: 0,
          integratorAddress: null,
          chargeId: charge.id,
          payer: {
            name: dto.payer.name.trim(),
            document: dto.payer.document.trim(),
            email: dto.payer.email.trim().toLowerCase(),
          },
          payerTokenHash: payerTokenHashOf(payerToken),
          clientKey,
        });
      },
      { timeout: this.networks.timeoutMs() * 4, maxWait: 5_000 },
    );
    const opened = await this.opener.openViaMatcher(deployment, row);
    return {
      ...(await this.view(opened)),
      payerToken,
    };
  }

  private async view(row: P2pOrderRow): Promise<P2pCheckoutOrderEntity> {
    return toCheckoutOrderView(
      row,
      await this.paymentMethods.paymentDetailsOf(row.merchantPaymentMethodId),
    );
  }

  /** The order its payer token opens, or the 404 of a missing one (a wrong token included). */
  private async payerOrder(
    id: string,
    token: string | undefined,
  ): Promise<P2pOrderRow> {
    const row =
      isUuid(id) && token
        ? await this.prisma.p2pOrder.findFirst({
            where: {
              id,
              kind: 'CHARGE',
              payerTokenHash: payerTokenHashOf(token),
            },
            select: P2P_ORDER_SELECT,
          })
        : null;
    if (!row) throw ApiError.notFound(`P2P checkout order ${id} not found`);
    return row;
  }

  async getOrder(
    id: string,
    token: string | undefined,
  ): Promise<P2pCheckoutOrderEntity> {
    return this.view(await this.payerOrder(id, token));
  }

  /** The payer sent the transfer: the matcher marks the order paid for them. */
  async reportPaid(
    id: string,
    token: string | undefined,
    dto: ReportP2pMarketPaidDto,
  ): Promise<P2pCheckoutOrderEntity> {
    const row = await this.payerOrder(id, token);
    return this.view(
      await this.orders.sendBuyerAct(row, 'paid', dto.reference),
    );
  }

  /** The payer gives up before paying: the matcher cancels, freeing the charge. */
  async cancel(
    id: string,
    token: string | undefined,
  ): Promise<P2pCheckoutOrderEntity> {
    const row = await this.payerOrder(id, token);
    return this.view(await this.orders.sendBuyerAct(row, 'cancel'));
  }
}
