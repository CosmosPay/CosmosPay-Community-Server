import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { toChecksumAddress } from '@/chains/chain-address';
import { verifyMessageSignature } from '@/chains/message-signature';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { page, type Page } from '@/common/pagination';
import { isUniqueViolation } from '@/common/prisma-errors';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import type { StellarNetwork } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import type { PaginationQueryDto } from '@/common/dto/pagination.query.dto';
import type {
  CreateP2pMarketChallengeDto,
  RegisterP2pMarketAccountDto,
  UpdateP2pMarketAccountDto,
} from '@/p2p/dto/p2p-account.dto';
import type {
  P2pMarketAccountDetailEntity,
  P2pMarketAccountEntity,
  P2pMarketAccountNetworkEntity,
  P2pMarketChallengeEntity,
} from '@/p2p/entities/p2p-account.entity';
import { registrationMessage } from '@/p2p/p2p-account-challenge';
import { P2pMarketReader } from '@/p2p/p2p-market-reader.service';
import { P2pNetworksService } from '@/p2p/p2p-networks.service';
import { P2P_LIVE_STATUSES } from '@/p2p/p2p-order-status';
import {
  P2P_ACCOUNT_SELECT,
  toAccountView,
  type P2pAccountRow,
} from '@/p2p/p2p-views';
import {
  P2P_CHALLENGE_NONCE_BYTES,
  P2P_CHALLENGE_TTL_SECONDS,
} from '@/p2p/p2p.constants';

/** Challenges a registration tries, newest first: a wallet signs the one it was just given. */
const CHALLENGES_TRIED = 5;

/**
 * The wallets a consumer registered with the P2P market, on its key's tier.
 * Registering takes a signature of the wallet over a single-use challenge, so
 * a consumer can only register a wallet it holds; an address belongs to one
 * consumer per tier. Every lookup filters by consumer AND tier: another
 * consumer's account, or another tier's, is the 404 of a missing one.
 */
@Injectable()
export class P2pAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly networks: P2pNetworksService,
    private readonly reader: P2pMarketReader,
  ) {}

  async challenge(
    consumer: GatewayConsumer,
    dto: CreateP2pMarketChallengeDto,
  ): Promise<P2pMarketChallengeEntity> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const address = toChecksumAddress(dto.address);
    const nonce = randomBytes(P2P_CHALLENGE_NONCE_BYTES).toString('hex');
    const expiresAt = new Date(Date.now() + P2P_CHALLENGE_TTL_SECONDS * 1000);
    await this.prisma.p2pAccountChallenge.create({
      data: { consumerId, tier, address, nonce, expiresAt },
    });
    return {
      message: registrationMessage({
        address,
        consumer: consumer.username,
        tier,
        nonce,
        expiresAt,
      }),
      expiresAt,
    };
  }

  /**
   * Registers a wallet: the signature must recover the address over one of
   * its open challenges for this consumer and tier, and that challenge is then
   * used (a compare-and-swap on `usedAt`), so a signature registers once.
   */
  async register(
    consumer: GatewayConsumer,
    dto: RegisterP2pMarketAccountDto,
  ): Promise<P2pMarketAccountEntity> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const address = toChecksumAddress(dto.address);
    const now = new Date();
    const open = await this.prisma.p2pAccountChallenge.findMany({
      where: {
        consumerId,
        tier,
        address,
        usedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      take: CHALLENGES_TRIED,
      select: { id: true, nonce: true, expiresAt: true },
    });
    if (open.length === 0) {
      throw ApiError.badRequest(
        ApiErrorCode.P2pChallengeInvalid,
        'This challenge is unknown, already used or expired, or it was issued for another wallet: ask for a new one.',
      );
    }
    const signed = open.find((c) =>
      verifyMessageSignature(
        'monad',
        address,
        registrationMessage({
          address,
          consumer: consumer.username,
          tier,
          nonce: c.nonce,
          expiresAt: c.expiresAt,
        }),
        dto.signature,
      ),
    );
    if (!signed) {
      throw ApiError.badRequest(
        ApiErrorCode.P2pSignatureInvalid,
        'The signature does not verify against this wallet for the challenge message.',
      );
    }
    const used = await this.prisma.p2pAccountChallenge.updateMany({
      where: { id: signed.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (used.count !== 1) {
      throw ApiError.badRequest(
        ApiErrorCode.P2pChallengeInvalid,
        'This challenge is unknown, already used or expired, or it was issued for another wallet: ask for a new one.',
      );
    }
    try {
      const row = await this.prisma.p2pAccount.create({
        data: {
          consumerId,
          tier,
          address,
          label: dto.label?.trim() || null,
          displayName: dto.displayName?.trim() || null,
          verifiedAt: now,
        },
        select: P2P_ACCOUNT_SELECT,
      });
      return toAccountView(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw ApiError.conflict(
          ApiErrorCode.P2pAccountTaken,
          `This wallet is already registered on ${tier}.`,
        );
      }
      throw err;
    }
  }

  async list(
    consumer: GatewayConsumer,
    query: PaginationQueryDto,
  ): Promise<Page<P2pMarketAccountEntity>> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const where = { consumerId, tier };
    const [rows, total] = await Promise.all([
      this.prisma.p2pAccount.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: P2P_ACCOUNT_SELECT,
      }),
      this.prisma.p2pAccount.count({ where }),
    ]);
    return page(rows.map(toAccountView), total, query);
  }

  /** One account with what the contract holds for it on every live network. */
  async get(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<P2pMarketAccountDetailEntity> {
    const tier = this.networks.tierFor(consumer);
    const row = await this.owned(
      await this.consumers.resolveId(consumer),
      tier,
      id,
    );
    return { ...toAccountView(row), networks: await this.onchain(row, tier) };
  }

  private async onchain(
    row: P2pAccountRow,
    tier: StellarNetwork,
  ): Promise<P2pMarketAccountNetworkEntity[]> {
    const matcher = this.networks.matcherAddress();
    const [deployments, locked] = await Promise.all([
      this.reader.liveDeployments(tier),
      this.lockedByToken(row.address, tier),
    ]);
    const seen = (row.operators ?? {}) as Record<
      string,
      Record<string, number> | undefined
    >;
    const results = await Promise.all(
      deployments.map(async (d) => {
        try {
          const [balances, terms] = await Promise.all([
            Promise.all(
              d.tokens.map(async (t) => ({
                symbol: t.symbol,
                token: t.address,
                decimals: t.decimals,
                amount: (
                  await this.reader.balanceOf(d, row.address, t.address, true)
                ).toString(),
                locked: (
                  locked.get(`${d.network}:${t.address}`) ?? 0n
                ).toString(),
              })),
            ),
            matcher
              ? this.reader.matcherTerms(d, row.address, matcher, true)
              : Promise.resolve({ maxPerOrder: 0n, autoSettle: false }),
          ]);
          const operators = Object.fromEntries(
            Object.entries(seen[d.network] ?? {}).filter(
              ([, bits]) => bits > 0,
            ),
          );
          return [
            {
              network: d.network,
              balances,
              matcher: {
                maxPerOrder: terms.maxPerOrder.toString(),
                autoSettle: terms.autoSettle,
              },
              operators,
            },
          ];
        } catch {
          return [];
        }
      }),
    );
    return results.flat();
  }

  /**
   * What `address` has locked in live orders, per `network:token`, from this
   * service's own order rows: the amount of each order it sells in (open
   * on-chain: acceptance, payment, paid, disputed), plus the bond of each it
   * accepted as the buyer. An order opened outside this API is not counted:
   * the contract's own free balance is the authority.
   */
  private async lockedByToken(
    address: string,
    tier: StellarNetwork,
  ): Promise<Map<string, bigint>> {
    const open = [
      'awaiting_acceptance',
      'awaiting_payment',
      'paid',
      'disputed',
    ];
    const accepted = ['awaiting_payment', 'paid', 'disputed'];
    const rows = await this.prisma.p2pOrder.findMany({
      where: {
        tier,
        OR: [
          { sellerAddress: address, status: { in: open } },
          {
            buyerAddress: address,
            status: { in: accepted },
            bond: { not: '0' },
          },
        ],
      },
      select: {
        network: true,
        token: true,
        sellerAddress: true,
        tokenAmount: true,
        bond: true,
      },
    });
    const totals = new Map<string, bigint>();
    for (const o of rows) {
      const key = `${o.network}:${o.token}`;
      const part =
        o.sellerAddress === address ? BigInt(o.tokenAmount) : BigInt(o.bond);
      totals.set(key, (totals.get(key) ?? 0n) + part);
    }
    return totals;
  }

  async update(
    consumer: GatewayConsumer,
    id: string,
    dto: UpdateP2pMarketAccountDto,
  ): Promise<P2pMarketAccountEntity> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const row = await this.owned(consumerId, tier, id);
    if (dto.merchantStatus && row.merchantStatus === 'SUSPENDED') {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        'This account is suspended by the platform: its status cannot be changed here.',
      );
    }
    const updated = await this.prisma.p2pAccount.updateMany({
      where: {
        id: row.id,
        consumerId,
        tier,
        // Never lifts a suspension that landed meanwhile.
        ...(dto.merchantStatus ? { merchantStatus: { not: 'SUSPENDED' } } : {}),
      },
      data: {
        ...(dto.label !== undefined ? { label: dto.label.trim() || null } : {}),
        ...(dto.displayName !== undefined
          ? { displayName: dto.displayName.trim() || null }
          : {}),
        ...(dto.merchantStatus ? { merchantStatus: dto.merchantStatus } : {}),
      },
    });
    if (updated.count !== 1) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        'This account is suspended by the platform: its status cannot be changed here.',
      );
    }
    return toAccountView(await this.owned(consumerId, tier, id));
  }

  /**
   * Forgets an account, its payment methods and offers. Refused while an
   * order it is the merchant of is live: the counterparty still needs its
   * payment details. Its tokens are never touched: they stay in the contract,
   * withdrawable by the wallet.
   */
  async remove(consumer: GatewayConsumer, id: string): Promise<void> {
    const tier = this.networks.tierFor(consumer);
    const consumerId = await this.consumers.resolveId(consumer);
    const row = await this.owned(consumerId, tier, id);
    const live = await this.prisma.p2pOrder.count({
      where: {
        tier,
        status: { in: [...P2P_LIVE_STATUSES] },
        OR: [
          { merchantAccountId: row.id },
          { sellerAddress: row.address, consumerId },
        ],
      },
    });
    if (live > 0) {
      throw ApiError.conflict(
        ApiErrorCode.OperationInFlight,
        'This account has live orders: wait until they end before removing it.',
      );
    }
    await this.prisma.p2pAccount.deleteMany({
      where: { id: row.id, consumerId, tier },
    });
  }

  /** The caller's account by id, on its tier, or the 404 of a missing one. */
  async owned(
    consumerId: string,
    tier: StellarNetwork,
    id: string,
  ): Promise<P2pAccountRow> {
    const row = await this.prisma.p2pAccount.findFirst({
      where: { id, consumerId, tier },
      select: P2P_ACCOUNT_SELECT,
    });
    if (!row) throw ApiError.notFound(`P2P account ${id} not found`);
    return row;
  }

  /** The caller's account by id or by address, on its tier, or a 404. */
  async ownedByRef(
    consumerId: string,
    tier: StellarNetwork,
    ref: string,
  ): Promise<P2pAccountRow> {
    const byAddress = /^0x[0-9a-fA-F]{40}$/.test(ref);
    const row = await this.prisma.p2pAccount.findFirst({
      where: byAddress
        ? { address: toChecksumAddress(ref), consumerId, tier }
        : { id: ref, consumerId, tier },
      select: P2P_ACCOUNT_SELECT,
    });
    if (!row) throw ApiError.notFound(`P2P account ${ref} not found`);
    return row;
  }

  /** The caller's only account on its tier, or a 400 asking which. */
  async soleAccount(
    consumerId: string,
    tier: StellarNetwork,
    purpose: string,
  ): Promise<P2pAccountRow> {
    const rows = await this.prisma.p2pAccount.findMany({
      where: { consumerId, tier },
      take: 2,
      select: P2P_ACCOUNT_SELECT,
    });
    if (rows.length !== 1) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        rows.length === 0
          ? `Register a wallet first (POST /v1/p2p/accounts): it is the account ${purpose}.`
          : `You have several accounts: name the one ${purpose}.`,
      );
    }
    return rows[0];
  }
}
