import { Injectable } from '@nestjs/common';
import type { AdminPrincipal } from '@/admin/admin-auth';
import { adminSkip, adminTake } from '@/admin/admin-list';
import { AdminAuditService } from '@/admin/admin-audit.service';
import { recordAuditInTransaction, toAuditEntry } from '@/audit/audit-writer';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { StellarNetwork } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import type {
  AdminP2pDisputesQueryDto,
  AdminP2pResolutionDto,
} from '@/p2p/dto/p2p-admin.dto';
import { P2pDataCipher } from '@/p2p/p2p-data-cipher';
import { decodeAddress, p2pCalldata } from '@/p2p/p2p-market-abi';
import { P2pChainClient } from '@/p2p/p2p-chain.client';
import { P2pNetworksService } from '@/p2p/p2p-networks.service';
import { isUuid } from '@/p2p/p2p-order-ref';
import { P2pOrdersService } from '@/p2p/p2p-orders.service';
import { P2P_ORDER_SELECT } from '@/p2p/p2p-views';

const MAX_UINT128 = (1n << 128n) - 1n;

/**
 * The platform console's view of the P2P market: the disputes waiting for the
 * arbiter, one order in full (both parties' details, for the evidence), the
 * arbiter's `resolve` transaction built for its own wallet to sign (the
 * arbiter's key is never on this server), and merchant suspension. Behind
 * `AdminGuard`; every read and write is audited.
 */
@Injectable()
export class P2pAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly networks: P2pNetworksService,
    private readonly chain: P2pChainClient,
    private readonly orders: P2pOrdersService,
    private readonly cipher: P2pDataCipher,
    private readonly audit: AdminAuditService,
  ) {}

  async disputes(query: AdminP2pDisputesQueryDto) {
    const where = {
      status: 'disputed',
      ...(query.tier ? { tier: query.tier } : {}),
    };
    const take = adminTake(query.take);
    const skip = adminSkip(query.skip);
    const [rows, total] = await Promise.all([
      this.prisma.p2pOrder.findMany({
        where,
        orderBy: { updatedAt: 'asc' },
        take,
        skip,
        select: P2P_ORDER_SELECT,
      }),
      this.prisma.p2pOrder.count({ where }),
    ]);
    return {
      data: await Promise.all(rows.map((r) => this.orders.merchantView(r))),
      total,
      take,
      skip,
    };
  }

  private async load(id: string) {
    const row = isUuid(id)
      ? await this.prisma.p2pOrder.findUnique({
          where: { id },
          select: { ...P2P_ORDER_SELECT, payerInfo: true, beneficiary: true },
        })
      : null;
    if (!row) throw ApiError.notFound(`P2P order ${id} not found`);
    return row;
  }

  /** One order with both parties' details and its matcher transactions. */
  async order(id: string) {
    const { payerInfo, beneficiary, ...row } = await this.load(id);
    const [client, matcherTxs] = await Promise.all([
      this.orders.clientView(row, true),
      this.prisma.p2pMatcherTx.findMany({
        where: { orderId: id },
        orderBy: { createdAt: 'asc' },
        select: {
          kind: true,
          hash: true,
          nonce: true,
          status: true,
          lastError: true,
          createdAt: true,
        },
      }),
    ]);
    return {
      ...client,
      consumerId: row.consumerId,
      merchantConsumerId: row.merchantConsumerId,
      merchantAccountId: row.merchantAccountId,
      payer: payerInfo ? this.cipher.open('order.payer', id, payerInfo) : null,
      beneficiary: beneficiary
        ? this.cipher.open('order.beneficiary', id, beneficiary)
        : null,
      matcherTransactions: matcherTxs.map((t) => ({
        ...t,
        nonce: t.nonce.toString(),
      })),
    };
  }

  /**
   * The arbiter's `resolve(id, toBuyer, bondToSeller)`, unsigned, for its own
   * wallet (a multisig) to sign. Built only for a disputed order, with a split
   * the contract accepts (at most the amount and the bond), and the arbiter the
   * contract names now, so the console shows who must sign.
   */
  async resolution(
    id: string,
    dto: AdminP2pResolutionDto,
    actor: AdminPrincipal,
  ) {
    const row = await this.load(id);
    if (row.status !== 'disputed' || !row.onchainId) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Order ${id} is ${row.status}: only a disputed order is resolved.`,
      );
    }
    const toBuyer = BigInt(dto.toBuyer);
    const bondToSeller = BigInt(dto.bondToSeller ?? '0');
    if (
      toBuyer > BigInt(row.tokenAmount) ||
      bondToSeller > BigInt(row.bond) ||
      toBuyer > MAX_UINT128
    ) {
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, [
        `toBuyer must be at most ${row.tokenAmount} and bondToSeller at most ${row.bond}`,
      ]);
    }
    const d = this.networks.find(row.tier as StellarNetwork, row.network);
    if (!d) {
      throw ApiError.badRequest(
        ApiErrorCode.NetworkUnsupported,
        `The P2P market is no longer configured on ${row.network} (${row.tier}).`,
      );
    }
    const arbiter = decodeAddress(
      await this.chain.ethCall(d, {
        to: d.contract,
        data: p2pCalldata.arbiter(),
      }),
    );
    await this.audit.record({
      actor,
      action: 'p2p.resolution.built',
      resourceType: 'p2p_order',
      resourceId: id,
      metadata: { toBuyer: dto.toBuyer, bondToSeller: bondToSeller.toString() },
    });
    return {
      orderId: id,
      arbiter,
      transaction: {
        chainId: d.chainId,
        to: d.contract,
        data: p2pCalldata.resolve(BigInt(row.onchainId), toBuyer, bondToSeller),
        value: '0',
        description: `Resolve order ${row.onchainId}: ${toBuyer} base units to the buyer, the rest to the seller, ${bondToSeller} of the bond to the seller`,
      },
    };
  }

  /** SUSPENDED stops a merchant from being matched; only the platform lifts it. */
  async setMerchantStatus(
    accountId: string,
    status: 'ACTIVE' | 'SUSPENDED',
    actor: AdminPrincipal,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.p2pAccount.updateMany({
        where: { id: accountId },
        data: { merchantStatus: status },
      });
      if (updated.count !== 1)
        throw ApiError.notFound(`P2P account ${accountId} not found`);
      await recordAuditInTransaction(
        tx,
        toAuditEntry(
          actor,
          `p2p.merchant.${status.toLowerCase()}`,
          'p2p_account',
          accountId,
        ),
      );
      return tx.p2pAccount.findUniqueOrThrow({
        where: { id: accountId },
        select: {
          id: true,
          tier: true,
          address: true,
          displayName: true,
          merchantStatus: true,
        },
      });
    });
  }
}
