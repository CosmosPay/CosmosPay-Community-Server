import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@generated/prisma/client';
import type { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { P2pCallReverted } from '@/p2p/p2p-chain.client';
import { P2pDataCipher } from '@/p2p/p2p-data-cipher';
import { p2pCalldata } from '@/p2p/p2p-market-abi';
import { P2pMatcherService } from '@/p2p/p2p-matcher.service';
import type { P2pToken } from '@/p2p/p2p-networks';
import type { P2pDeployment } from '@/p2p/p2p-networks.service';
import { openParamsOf, orderRef } from '@/p2p/p2p-order-ref';
import { P2P_LIVE_STATUSES, type P2pOrderKind } from '@/p2p/p2p-order-status';
import { formatUnits } from '@/p2p/p2p-pricing';
import { noMatch, type P2pMatch } from '@/p2p/p2p-quotes.service';
import { P2P_ORDER_SELECT, type P2pOrderRow } from '@/p2p/p2p-views';
import { P2pWebhooks } from '@/p2p/p2p-webhooks.service';
import {
  P2P_CURRENCIES,
  P2P_MERCHANT_LOCK_CLASS,
  type P2pCurrency,
} from '@/p2p/p2p.constants';

/** Everything a new order is made of. */
export interface P2pNewOrder {
  id: string;
  consumerId: string;
  kind: P2pOrderKind;
  deployment: P2pDeployment;
  token: P2pToken;
  match: P2pMatch;
  currency: string;
  rail: string;
  sellerAddress: string;
  buyerAddress: string;
  openerAddress: string;
  windows: {
    acceptWindow: number;
    paymentWindow: number;
    settleWindow: number;
  };
  protocolFeeBps: number;
  integratorFeeBps: number;
  integratorAddress: string | null;
  quoteId?: string;
  chargeId?: string;
  payoutBatchId?: string;
  externalReference?: string | null;
  /** Sealed here, under the order's id. */
  payer?: { name: string; document: string; email?: string };
  beneficiary?: {
    holderName: string;
    document: string;
    rail: string;
    details: Record<string, string>;
  };
  payerTokenHash?: string;
  clientKey?: string;
}

/**
 * Makes orders: one row per trade, written under its merchant's lock (so two
 * orders cannot both take a merchant's last slot), then, for the kinds the
 * matcher opens (purchases, charges, payouts), the matcher's `open`. A revert
 * in that simulation fails the order before anything is signed: the merchant
 * could no longer fill it.
 */
@Injectable()
export class P2pOrderOpener {
  private readonly logger = new Logger(P2pOrderOpener.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly cipher: P2pDataCipher,
    private readonly matcher: P2pMatcherService,
    private readonly webhooks: P2pWebhooks,
  ) {}

  /** Writes the order `pending`, or refuses when its merchant has no slot left. */
  async insert(input: P2pNewOrder): Promise<P2pOrderRow> {
    const { match, deployment: d } = input;
    const max = this.config.get('p2p', { infer: true }).merchantMaxOpenOrders;
    const decimals = P2P_CURRENCIES[input.currency as P2pCurrency].decimals;
    const data: Prisma.P2pOrderUncheckedCreateInput = {
      id: input.id,
      ref: orderRef(input.id),
      consumerId: input.consumerId,
      tier: d.tier,
      kind: input.kind,
      network: d.network,
      contract: d.contract,
      token: input.token.address,
      tokenSymbol: input.token.symbol,
      tokenDecimals: input.token.decimals,
      merchantAccountId: match.account.id,
      merchantConsumerId: match.account.consumerId,
      merchantAddress: match.account.address,
      merchantDisplayName: match.account.displayName,
      merchantPaymentMethodId: match.paymentMethodId,
      offerId: match.offerId,
      offerSnapshot: match.offerSnapshot as Prisma.InputJsonValue,
      quoteId: input.quoteId ?? null,
      price: match.price,
      fiatAmount: formatUnits(match.amounts.fiatUnits, decimals),
      currency: input.currency,
      rail: input.rail,
      tokenAmount: match.amounts.grossTokens.toString(),
      netAmount: match.amounts.netTokens.toString(),
      protocolFeeBps: input.protocolFeeBps,
      integratorFeeBps: input.integratorFeeBps,
      integratorAddress: input.integratorAddress,
      sellerAddress: input.sellerAddress,
      buyerAddress: input.buyerAddress,
      bond: match.bond.toString(),
      acceptWindow: input.windows.acceptWindow,
      paymentWindow: input.windows.paymentWindow,
      settleWindow: input.windows.settleWindow,
      openerAddress: input.openerAddress,
      payerInfo: input.payer
        ? this.cipher.seal('order.payer', input.id, input.payer)
        : null,
      beneficiary: input.beneficiary
        ? this.cipher.seal('order.beneficiary', input.id, input.beneficiary)
        : null,
      chargeId: input.chargeId ?? null,
      payoutBatchId: input.payoutBatchId ?? null,
      externalReference: input.externalReference ?? null,
      payerTokenHash: input.payerTokenHash ?? null,
      clientKey: input.clientKey ?? null,
    };
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${P2P_MERCHANT_LOCK_CLASS}::int, hashtext(${match.account.id}))`;
      const live = await tx.p2pOrder.count({
        where: {
          merchantAccountId: match.account.id,
          status: { in: [...P2P_LIVE_STATUSES] },
        },
      });
      if (live >= max) throw noMatch();
      return tx.p2pOrder.create({ data, select: P2P_ORDER_SELECT });
    });
  }

  /**
   * The matcher opens the order on its seller's balance. A simulation the
   * contract would revert fails the order (`no_match`): the merchant's balance
   * or its matcher terms changed since the quote. Answers the order as it
   * stands after.
   */
  async openViaMatcher(
    d: P2pDeployment,
    row: P2pOrderRow,
  ): Promise<P2pOrderRow> {
    const params = openParamsOf(row);
    try {
      const hash = await this.matcher.send(d, {
        kind: 'open',
        orderId: row.id,
        data: p2pCalldata.open(params),
      });
      return this.prisma.p2pOrder.update({
        where: { id: row.id },
        data: { openTxHash: hash },
        select: P2P_ORDER_SELECT,
      });
    } catch (err) {
      if (err instanceof P2pCallReverted) {
        this.logger.warn(
          `P2P order ${row.id}: the matcher's open would revert (${err.reason}); failed`,
        );
        await this.fail(
          row.id,
          `the merchant could no longer fill it (${err.contractError ?? 'refused'})`,
        );
        throw noMatch();
      }
      // Not signed (a node error before the transaction existed): fail it too,
      // so it never holds the merchant's slot.
      await this.fail(row.id, 'the order could not be opened');
      throw err;
    }
  }

  /** `pending` → `failed`, once; emits `P2P_ORDER_FAILED`. */
  async fail(orderId: string, reason: string): Promise<void> {
    const moved = await this.prisma.p2pOrder.updateMany({
      where: { id: orderId, status: 'pending' },
      data: { status: 'failed', failureReason: reason, endedAt: new Date() },
    });
    if (moved.count !== 1) return;
    const row = await this.prisma.p2pOrder.findUnique({
      where: { id: orderId },
      select: P2P_ORDER_SELECT,
    });
    if (row) await this.webhooks.order('P2P_ORDER_FAILED', row);
  }
}
