import { Injectable } from '@nestjs/common';
import type {
  CrossChainSwapStatus,
  PaymentIntentStatus,
  SwapStatus,
} from '@generated/prisma/client';
import { AdminExtensions } from '@/admin/admin-extensions';
import {
  ADMIN_CONSUMER_INCLUDE as consumerSelect,
  type AdminListOpts as ListOpts,
  adminSkip as skip,
  adminTake as take,
  consumerWhere,
  sumCounts as sum,
  tallyBy,
} from '@/admin/admin-list';
import { PrismaService } from '@/prisma/prisma.service';

function num(amount: string | null): number {
  if (!amount) return 0;
  const v = Number(amount);
  return Number.isFinite(v) ? v : 0;
}
function money(n: number): string {
  return Number(n.toFixed(7)).toString();
}

/**
 * Platform-admin (owner) reads: the SAME data as the per-consumer services, but across
 * EVERY consumer/organization — no consumer scoping. Reached only via the AdminGuard
 * (a platform-console call). Every list carries the owning consumer for attribution.
 *
 * Only the core's own tables are read here. A native plugin that keeps rows of its
 * own (BlindPay's receivers, payins and payouts) serves its admin routes itself and
 * adds its section of the summary through {@link AdminExtensions}.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly extensions: AdminExtensions,
  ) {}

  /** Global, cross-consumer summary — the owner's "everything at a glance". */
  async summary(network?: string) {
    const netWhere = network ? { network } : {};

    const [
      consumers,
      customers,
      products,
      webhookEndpoints,
      intentsByStatus,
      swapsByStatus,
      chainSwapsByStatus,
      crossChainSwapsByStatus,
      succeededIntents,
      sections,
    ] = await Promise.all([
      this.prisma.consumer.count(),
      this.prisma.customer.count(),
      this.prisma.product.count(),
      this.prisma.webhookEndpoint.count(),
      this.prisma.paymentIntent.groupBy({
        by: ['status'],
        where: netWhere,
        _count: { _all: true },
      }),
      this.prisma.swap.groupBy({
        by: ['status'],
        where: netWhere,
        _count: { _all: true },
      }),
      // Solana (Jupiter) and Monad (Kuru Flow) swaps, and swaps between chains:
      // both mainnet-only, so a testnet summary counts none of them.
      this.prisma.chainSwap.groupBy({
        by: ['status'],
        where: netWhere,
        _count: { _all: true },
      }),
      this.prisma.crossChainSwap.groupBy({
        by: ['status'],
        where: netWhere,
        _count: { _all: true },
      }),
      this.prisma.paymentIntent.findMany({
        where: { status: 'SUCCEEDED', ...netWhere },
        select: { amount: true, asset: true, chain: true },
      }),
      Promise.all(
        this.extensions
          .list()
          .map(async (ext) => [ext.key, await ext.summary()] as const),
      ),
    ]);

    // Settled volume per asset (succeeded payment intents). An asset code is
    // only unique per chain, so a chain other than Stellar prefixes it.
    const volMap = new Map<string, { amount: number; count: number }>();
    for (const i of succeededIntents) {
      const code = !i.asset || i.asset === 'native' ? 'XLM' : i.asset;
      const key = i.chain === 'stellar' ? code : `${i.chain}:${i.asset}`;
      const cur = volMap.get(key) ?? { amount: 0, count: 0 };
      cur.amount += num(i.amount);
      cur.count += 1;
      volMap.set(key, cur);
    }
    const volume = [...volMap.entries()].map(([asset, v]) => ({
      asset,
      amount: money(v.amount),
      count: v.count,
    }));

    const paymentIntents = tallyBy(intentsByStatus, 'status');
    const swaps = tallyBy(swapsByStatus, 'status');
    const chainSwaps = tallyBy(chainSwapsByStatus, 'status');
    const crossChainSwaps = tallyBy(crossChainSwapsByStatus, 'status');

    return {
      network: network ?? 'all',
      consumers,
      customers,
      products,
      webhookEndpoints,
      paymentIntents: { total: sum(paymentIntents), byStatus: paymentIntents },
      swaps: { total: sum(swaps), byStatus: swaps },
      chainSwaps: { total: sum(chainSwaps), byStatus: chainSwaps },
      crossChainSwaps: {
        total: sum(crossChainSwaps),
        byStatus: crossChainSwaps,
      },
      ...Object.fromEntries(sections),
      volume,
    };
  }

  /** Every consumer (organization key) with per-resource counts. */
  async consumers(t?: number, s?: number) {
    const where = {};
    const [rows, total] = await Promise.all([
      this.prisma.consumer.findMany({
        where,
        take: take(t),
        skip: skip(s),
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: {
              paymentIntents: true,
              swaps: true,
              chainSwaps: true,
              crossChainSwaps: true,
              products: true,
              customers: true,
              webhookEndpoints: true,
            },
          },
        },
      }),
      this.prisma.consumer.count({ where }),
    ]);

    // Each plugin's counts for this page, merged into the core's `_count`.
    const ids = rows.map((r) => r.id);
    const extra = await Promise.all(
      this.extensions.list().map((ext) => ext.countsByConsumer(ids)),
    );
    const data = rows.map((row) => ({
      ...row,
      _count: Object.assign(
        { ...row._count },
        ...extra.map((counts) => counts.get(row.id) ?? {}),
      ) as Record<string, number>,
    }));
    return { data, total, take: take(t), skip: skip(s) };
  }

  async paymentIntents(
    opts: ListOpts & { network?: string; status?: PaymentIntentStatus },
  ) {
    const where = {
      ...consumerWhere(opts.consumer),
      ...(opts.network ? { network: opts.network } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.paymentIntent.findMany({
        where,
        take: take(opts.take),
        skip: skip(opts.skip),
        orderBy: { createdAt: 'desc' },
        include: consumerSelect,
      }),
      this.prisma.paymentIntent.count({ where }),
    ]);
    return { data, total, take: take(opts.take), skip: skip(opts.skip) };
  }

  async swaps(opts: ListOpts & { network?: string; status?: SwapStatus }) {
    const where = {
      ...consumerWhere(opts.consumer),
      ...(opts.network ? { network: opts.network } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.swap.findMany({
        where,
        take: take(opts.take),
        skip: skip(opts.skip),
        orderBy: { createdAt: 'desc' },
        include: consumerSelect,
      }),
      this.prisma.swap.count({ where }),
    ]);
    return { data, total, take: take(opts.take), skip: skip(opts.skip) };
  }

  /**
   * Solana and Monad swaps across every consumer. The aggregator's raw quote is
   * left out: it is a support artefact, not something the console renders.
   */
  async chainSwaps(opts: ListOpts & { chain?: string; status?: SwapStatus }) {
    const where = {
      ...consumerWhere(opts.consumer),
      ...(opts.chain ? { chain: opts.chain } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.chainSwap.findMany({
        where,
        take: take(opts.take),
        skip: skip(opts.skip),
        orderBy: { createdAt: 'desc' },
        include: consumerSelect,
        omit: { quote: true },
      }),
      this.prisma.chainSwap.count({ where }),
    ]);
    return { data, total, take: take(opts.take), skip: skip(opts.skip) };
  }

  /** Cross-chain swaps (NEAR Intents) across every consumer, raw quote left out. */
  async crossChainSwaps(opts: ListOpts & { status?: CrossChainSwapStatus }) {
    const where = {
      ...consumerWhere(opts.consumer),
      ...(opts.status ? { status: opts.status } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.crossChainSwap.findMany({
        where,
        take: take(opts.take),
        skip: skip(opts.skip),
        orderBy: { createdAt: 'desc' },
        include: consumerSelect,
        omit: { quote: true },
      }),
      this.prisma.crossChainSwap.count({ where }),
    ]);
    return { data, total, take: take(opts.take), skip: skip(opts.skip) };
  }

  async customers(opts: ListOpts = {}) {
    const where = consumerWhere(opts.consumer);
    const [data, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        take: take(opts.take),
        skip: skip(opts.skip),
        orderBy: { createdAt: 'desc' },
        include: consumerSelect,
      }),
      this.prisma.customer.count({ where }),
    ]);
    return { data, total, take: take(opts.take), skip: skip(opts.skip) };
  }

  async products(opts: ListOpts = {}) {
    const where = consumerWhere(opts.consumer);
    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        take: take(opts.take),
        skip: skip(opts.skip),
        orderBy: { createdAt: 'desc' },
        include: consumerSelect,
      }),
      this.prisma.product.count({ where }),
    ]);
    return { data, total, take: take(opts.take), skip: skip(opts.skip) };
  }
}
