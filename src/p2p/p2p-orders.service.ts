import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { toChecksumAddress } from '@/chains/chain-address';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { page, type Page } from '@/common/pagination';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import type { StellarNetwork } from '@/config/configuration';
import { approveCalldata } from '@/evm/erc20';
import { PrismaService } from '@/prisma/prisma.service';
import type {
  CreateP2pMarketOrderDto,
  P2pMarketBeneficiaryDto,
  P2pMarketPayerDto,
  QueryP2pMarketOrdersDto,
  ReportP2pMarketPaidDto,
} from '@/p2p/dto/p2p-order.dto';
import type {
  P2pMarketBeneficiaryEntity,
  P2pMarketCreatedOrderEntity,
  P2pMarketMerchantOrderEntity,
  P2pMarketOrderEntity,
  P2pMarketPayerEntity,
} from '@/p2p/entities/p2p-order.entity';
import type { P2pMarketTransactionEntity } from '@/p2p/entities/p2p-transaction.entity';
import { P2pCallReverted } from '@/p2p/p2p-chain.client';
import { P2pDataCipher } from '@/p2p/p2p-data-cipher';
import { p2pCalldata, type P2pOrderAction } from '@/p2p/p2p-market-abi';
import { P2pMarketReader } from '@/p2p/p2p-market-reader.service';
import { P2pMatcherService } from '@/p2p/p2p-matcher.service';
import { P2P_NETWORKS, isP2pNetworkId } from '@/p2p/p2p-networks';
import { P2pNetworksService } from '@/p2p/p2p-networks.service';
import { P2pOrderOpener } from '@/p2p/p2p-order-opener.service';
import { isUuid, openParamsOf } from '@/p2p/p2p-order-ref';
import type { P2pOrderKind } from '@/p2p/p2p-order-status';
import { P2pPaymentMethodsService } from '@/p2p/p2p-payment-methods.service';
import { formatUnits } from '@/p2p/p2p-pricing';
import {
  isDocumentNumber,
  isP2pRailId,
  isPersonName,
  validateRailDetails,
} from '@/p2p/p2p-rails';
import {
  P2pQuotesService,
  fiatUnitsOf,
  noMatch,
  windowsFor,
} from '@/p2p/p2p-quotes.service';
import {
  P2P_ORDER_SELECT,
  isLive,
  toMerchantOrderView,
  toOrderView,
  type P2pOrderRow,
} from '@/p2p/p2p-views';

/** The matcher acts for the buyer only on the orders it opened for a person or a payer. */
const MATCHER_BUYER_KINDS: readonly P2pOrderKind[] = ['BUY', 'CHARGE'];

/** A sealed payer identity, as the merchant reads it. */
interface SealedPayer {
  name: string;
  document: string;
  email?: string;
}

/**
 * P2P orders: the client's routes (create from a quote, read, report paid,
 * cancel, dispute) and the merchant's reads. Every lookup is by consumer AND
 * tier: the client's by `consumerId`, the merchant's by `merchantConsumerId`,
 * so neither reads an order of the other's that it is not a party to.
 */
@Injectable()
export class P2pOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly networks: P2pNetworksService,
    private readonly reader: P2pMarketReader,
    private readonly quotes: P2pQuotesService,
    private readonly opener: P2pOrderOpener,
    private readonly matcher: P2pMatcherService,
    private readonly paymentMethods: P2pPaymentMethodsService,
    private readonly cipher: P2pDataCipher,
  ) {}

  /** The chain id an order's network has on its tier, from the table (no RPC). */
  chainIdOf(row: { network: string; tier: string }): number {
    return isP2pNetworkId(row.network)
      ? (P2P_NETWORKS[row.network].tiers[row.tier as StellarNetwork]?.chainId ??
          0)
      : 0;
  }

  /** The client's view; the merchant's payment details only on a live purchase or charge. */
  async clientView(
    row: P2pOrderRow,
    withDetails: boolean,
  ): Promise<P2pMarketOrderEntity> {
    const details =
      withDetails &&
      MATCHER_BUYER_KINDS.includes(row.kind as P2pOrderKind) &&
      isLive(row.status)
        ? await this.paymentMethods.paymentDetailsOf(
            row.merchantPaymentMethodId,
          )
        : null;
    return toOrderView(row, this.chainIdOf(row), details);
  }

  /** The merchant's view; the other party's details only while the order is live. */
  async merchantView(row: P2pOrderRow): Promise<P2pMarketMerchantOrderEntity> {
    let payer: P2pMarketPayerEntity | null = null;
    let beneficiary: P2pMarketBeneficiaryEntity | null = null;
    if (isLive(row.status)) {
      const sealed = await this.prisma.p2pOrder.findUnique({
        where: { id: row.id },
        select: { payerInfo: true, beneficiary: true },
      });
      if (sealed?.payerInfo) {
        const p = this.cipher.open<SealedPayer>(
          'order.payer',
          row.id,
          sealed.payerInfo,
        );
        payer = { name: p.name, document: p.document };
      }
      if (sealed?.beneficiary) {
        beneficiary = this.cipher.open<P2pMarketBeneficiaryEntity>(
          'order.beneficiary',
          row.id,
          sealed.beneficiary,
        );
      }
    }
    return toMerchantOrderView(row, this.chainIdOf(row), {
      payer,
      beneficiary,
    });
  }

  private checkPayer(payer: P2pMarketPayerDto | undefined) {
    if (!payer) {
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, [
        'payer is required on a purchase: the merchant checks the transfer comes from this person',
      ]);
    }
    const errors: string[] = [];
    if (!isPersonName(payer.name))
      errors.push('payer.name must be a person’s name');
    if (!isDocumentNumber(payer.document)) {
      errors.push(
        'payer.document must be 4 to 20 letters, digits, dots or hyphens',
      );
    }
    if (errors.length)
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, errors);
    return { name: payer.name.trim(), document: payer.document.trim() };
  }

  /** A beneficiary checked against the order's rail: where the merchant will pay. */
  checkBeneficiary(
    beneficiary: P2pMarketBeneficiaryDto | undefined,
    rail: string,
    currency: string,
  ) {
    if (!beneficiary) {
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, [
        'beneficiary is required: it is where the merchant pays the local money',
      ]);
    }
    const errors: string[] = [];
    if (!isPersonName(beneficiary.holderName)) {
      errors.push(
        'beneficiary.holderName must be a person’s or a company’s name',
      );
    }
    if (!isDocumentNumber(beneficiary.document)) {
      errors.push(
        'beneficiary.document must be 4 to 20 letters, digits, dots or hyphens',
      );
    }
    const details = isP2pRailId(rail)
      ? validateRailDetails(rail, currency, beneficiary.details)
      : { ok: false as const, errors: [`rail ${rail} is not a rail`] };
    if (!details.ok)
      errors.push(...details.errors.map((e) => `beneficiary.${e}`));
    if (errors.length || !details.ok) {
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, errors);
    }
    return {
      holderName: beneficiary.holderName.trim(),
      document: beneficiary.document.trim(),
      rail,
      details: details.details,
    };
  }

  /**
   * An order from a quote. A purchase is opened by the matcher on the
   * merchant's balance; a sale answers the two transactions the seller's wallet
   * signs. One order per quote: a retry with the same quote and the same
   * wallet answers the order it made, another wallet is `409`.
   */
  async create(
    consumer: GatewayConsumer,
    dto: CreateP2pMarketOrderDto,
  ): Promise<P2pMarketCreatedOrderEntity> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const quote = await this.prisma.p2pQuote.findFirst({
      where: { id: dto.quoteId, consumerId, tier },
    });
    if (!quote) {
      throw ApiError.notFound(
        `P2P quote ${dto.quoteId} not found`,
        ApiErrorCode.QuoteNotFound,
      );
    }
    if (dto.kind && dto.kind !== quote.side) {
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, [
        `kind must be the quote's side (${quote.side})`,
      ]);
    }
    const wallet = quote.side === 'BUY' ? dto.recipient : dto.seller;
    if (!wallet) {
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, [
        quote.side === 'BUY'
          ? 'recipient is required on a purchase: the wallet that receives the tokens'
          : 'seller is required on a sale: the wallet that sends the tokens',
      ]);
    }
    const address = toChecksumAddress(wallet);

    const replay = await this.prisma.p2pOrder.findFirst({
      where: { quoteId: quote.id, consumerId, tier },
      select: P2P_ORDER_SELECT,
    });
    if (replay) {
      const replayWallet =
        quote.side === 'BUY' ? replay.buyerAddress : replay.sellerAddress;
      if (replayWallet !== address) {
        throw ApiError.conflict(
          ApiErrorCode.IdempotencyConflict,
          'An order already exists for this quote with another wallet. Quote again for a new order.',
        );
      }
      return {
        ...(await this.clientView(replay, true)),
        transactions:
          quote.side === 'SELL' && replay.status === 'pending'
            ? this.sellTransactions(replay)
            : [],
      };
    }

    if (quote.expiresAt <= new Date()) {
      throw ApiError.badRequest(
        ApiErrorCode.QuoteExpired,
        'This quote expired: quote again.',
      );
    }
    const deployment = await this.reader.requireLive(tier, quote.network);
    const token = this.networks.token(deployment, quote.token);
    const protocol = await this.quotes.openProtocol(deployment);
    if (protocol.feeBps !== quote.protocolFeeBps) {
      throw ApiError.badRequest(
        ApiErrorCode.QuoteExpired,
        'The protocol fee changed since this quote: quote again.',
      );
    }
    const merchant = await this.prisma.p2pAccount.findFirst({
      where: { id: quote.merchantAccountId, tier, merchantStatus: 'ACTIVE' },
      select: {
        id: true,
        consumerId: true,
        address: true,
        displayName: true,
        completedOrders: true,
        cancelledOrders: true,
        disputesLost: true,
        medianReleaseSeconds: true,
      },
    });
    if (!merchant?.displayName || merchant.address === address) throw noMatch();

    const side = quote.side as 'BUY' | 'SELL';
    const payer = side === 'BUY' ? this.checkPayer(dto.payer) : undefined;
    const beneficiary =
      side === 'SELL'
        ? this.checkBeneficiary(dto.beneficiary, quote.rail, quote.currency)
        : undefined;
    const paymentMethod =
      side === 'BUY'
        ? await this.paymentMethods.activeFor(
            merchant.id,
            quote.rail,
            quote.currency,
          )
        : null;
    if (side === 'BUY' && !paymentMethod) throw noMatch();

    const windows = windowsFor(side);
    const matcherAddress = this.networks.matcherAddress();
    if (side === 'BUY' && !matcherAddress) {
      throw ApiError.misconfigured(
        'The P2P market cannot open orders on this deployment right now.',
        'P2P_MATCHER_PRIVATE_KEY is not set.',
      );
    }
    const row = await this.opener.insert({
      id: randomUUID(),
      consumerId,
      kind: side,
      deployment,
      token,
      match: {
        offerId: quote.offerId,
        offerSnapshot: { price: quote.price, quoteId: quote.id },
        account: { ...merchant, displayName: merchant.displayName },
        price: quote.price,
        amounts: {
          fiatUnits: fiatUnitsOf(quote.currency, quote.fiatAmount),
          grossTokens: BigInt(quote.tokenAmount),
          protocolFee: BigInt(quote.protocolFee),
          integratorFee: BigInt(quote.integratorFee),
          netTokens: BigInt(quote.netAmount),
        },
        bond: BigInt(quote.bond),
        paymentMethodId: paymentMethod?.id ?? null,
      },
      currency: quote.currency,
      rail: quote.rail,
      sellerAddress: side === 'BUY' ? merchant.address : address,
      buyerAddress: side === 'BUY' ? address : merchant.address,
      openerAddress: side === 'BUY' ? (matcherAddress as string) : address,
      windows,
      protocolFeeBps: quote.protocolFeeBps,
      integratorFeeBps: quote.integratorFeeBps,
      integratorAddress: quote.integratorAddress,
      quoteId: quote.id,
      externalReference: dto.externalReference?.trim() || null,
      payer,
      beneficiary,
    });

    if (side === 'BUY') {
      const opened = await this.opener.openViaMatcher(deployment, row);
      return { ...(await this.clientView(opened, true)), transactions: [] };
    }
    return {
      ...(await this.clientView(row, true)),
      transactions: this.sellTransactions(row),
    };
  }

  /** What the seller's wallet signs to open a sale: the exact approval, then `openWithDeposit`. */
  private sellTransactions(row: P2pOrderRow): P2pMarketTransactionEntity[] {
    const chainId = this.chainIdOf(row);
    const amount = BigInt(row.tokenAmount);
    const human = `${formatUnits(amount, row.tokenDecimals).replace(/\.?0+$/, '')} ${row.tokenSymbol}`;
    return [
      {
        chainId,
        to: row.token,
        data: approveCalldata(row.contract, amount),
        value: '0',
        description: `Allow the P2P market to take exactly ${human}`,
      },
      {
        chainId,
        to: row.contract,
        data: p2pCalldata.openWithDeposit(openParamsOf(row)),
        value: '0',
        description: `Lock ${human} in a sale to ${row.merchantDisplayName ?? 'the merchant'}; it is released to them once you confirm their payment`,
      },
    ];
  }

  async list(
    consumer: GatewayConsumer,
    query: QueryP2pMarketOrdersDto,
  ): Promise<Page<P2pMarketOrderEntity>> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const where = {
      consumerId,
      tier,
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.p2pOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: P2P_ORDER_SELECT,
      }),
      this.prisma.p2pOrder.count({ where }),
    ]);
    return page(
      await Promise.all(rows.map((r) => this.clientView(r, false))),
      total,
      query,
    );
  }

  /** The caller's order (as its client), or the 404 of a missing one. */
  async owned(
    consumerId: string,
    tier: StellarNetwork,
    id: string,
  ): Promise<P2pOrderRow> {
    const row = isUuid(id)
      ? await this.prisma.p2pOrder.findFirst({
          where: { id, consumerId, tier },
          select: P2P_ORDER_SELECT,
        })
      : null;
    if (!row) throw ApiError.notFound(`P2P order ${id} not found`);
    return row;
  }

  async get(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<P2pMarketOrderEntity> {
    const tier = this.networks.tierFor(consumer);
    const row = await this.owned(
      await this.consumers.resolveId(consumer),
      tier,
      id,
    );
    return this.clientView(row, true);
  }

  /**
   * The buyer side's acts the matcher sends for a purchase or a charge: the
   * person reported the transfer (`markPaid`), gave up (`cancel`), or contests
   * a payment the merchant ignores (`dispute`). A sale's and a payout's are
   * signed by their own wallets (`POST /v1/p2p/transactions`); the matcher
   * only withdraws a payout nobody accepted yet.
   */
  async act(
    consumer: GatewayConsumer,
    id: string,
    action: 'paid' | 'cancel' | 'dispute',
    dto?: ReportP2pMarketPaidDto,
  ): Promise<P2pMarketOrderEntity> {
    const tier = this.networks.tierFor(consumer);
    const row = await this.owned(
      await this.consumers.resolveId(consumer),
      tier,
      id,
    );
    return this.clientView(
      await this.sendBuyerAct(row, action, dto?.reference),
      true,
    );
  }

  /** Validates and sends one matcher act for an order; shared with the keyless checkout. */
  async sendBuyerAct(
    row: P2pOrderRow,
    action: 'paid' | 'cancel' | 'dispute',
    reference?: string,
  ): Promise<P2pOrderRow> {
    const kind = row.kind as P2pOrderKind;
    const payoutWithdraw =
      kind === 'PAYOUT' &&
      action === 'cancel' &&
      row.status === 'awaiting_acceptance';
    if (!MATCHER_BUYER_KINDS.includes(kind) && !payoutWithdraw) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        kind === 'PAYOUT'
          ? 'A payout is cancelled here only before its merchant accepts it; release or dispute it from your wallet (POST /v1/p2p/transactions).'
          : 'A sale is signed by the seller’s wallet: build the transaction with POST /v1/p2p/transactions.',
      );
    }
    const needed: Record<typeof action, string[]> = {
      paid: ['awaiting_payment'],
      cancel: ['awaiting_payment', 'awaiting_acceptance'],
      dispute: ['paid'],
    };
    if (!row.onchainId || !needed[action].includes(row.status)) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `This order is ${row.status}: it cannot be ${action === 'paid' ? 'reported paid' : action === 'cancel' ? 'cancelled' : 'disputed'} now.`,
      );
    }
    const deployment = await this.reader.requireLive(
      row.tier as StellarNetwork,
      row.network,
    );
    const call: P2pOrderAction = action === 'paid' ? 'markPaid' : action;
    try {
      await this.matcher.send(deployment, {
        kind: call === 'markPaid' ? 'markPaid' : call,
        orderId: row.id,
        data: p2pCalldata.orderAction(call, BigInt(row.onchainId)),
      });
    } catch (err) {
      if (err instanceof P2pCallReverted) {
        throw ApiError.badRequest(
          ApiErrorCode.InvalidStateTransition,
          `The contract refused it (${err.contractError ?? 'refused'}): the order moved on-chain, read it again.`,
        );
      }
      throw err;
    }
    if (action === 'paid' && reference?.trim()) {
      await this.prisma.p2pOrder.updateMany({
        where: { id: row.id },
        data: { paidReference: reference.trim() },
      });
    }
    return (await this.prisma.p2pOrder.findUnique({
      where: { id: row.id },
      select: P2P_ORDER_SELECT,
    })) as P2pOrderRow;
  }

  // --- the merchant's reads ------------------------------------------------

  async merchantList(
    consumer: GatewayConsumer,
    query: QueryP2pMarketOrdersDto,
  ): Promise<Page<P2pMarketMerchantOrderEntity>> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const where = {
      merchantConsumerId: consumerId,
      tier,
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.p2pOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: P2P_ORDER_SELECT,
      }),
      this.prisma.p2pOrder.count({ where }),
    ]);
    return page(
      await Promise.all(rows.map((r) => this.merchantView(r))),
      total,
      query,
    );
  }

  async merchantGet(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<P2pMarketMerchantOrderEntity> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const row = isUuid(id)
      ? await this.prisma.p2pOrder.findFirst({
          where: { id, merchantConsumerId: consumerId, tier },
          select: P2P_ORDER_SELECT,
        })
      : null;
    if (!row) throw ApiError.notFound(`P2P order ${id} not found`);
    return this.merchantView(row);
  }
}
