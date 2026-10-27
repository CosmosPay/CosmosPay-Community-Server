import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@generated/prisma/client';
import { chainOfAddress, normalizeAddress } from '@/chains/chain-address';
import { type Chain } from '@/chains/chains.constants';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { formatNumericAmount } from '@/common/money';
import { isUniqueViolation } from '@/common/prisma-errors';
import { resolveNetwork } from '@/common/stellar-network';
import { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import {
  AUTO_CUSTOMER_REFERENCE,
  MAX_CUSTOMER_WALLETS,
} from '@/customers/customers.constants';
import { CreateCustomerDto } from '@/customers/dto/create-customer.dto';
import { CustomerWalletDto } from '@/customers/dto/customer-wallet.dto';
import { QueryCustomersDto } from '@/customers/dto/query-customers.dto';
import { UpdateCustomerDto } from '@/customers/dto/update-customer.dto';

/**
 * On-chain activity attributed to a customer: the payment intents whose payer (`source`) is
 * one of the customer's wallets, on that wallet's chain and the network the caller's key
 * targets.
 */
interface CustomerPaymentStats {
  payments: number;
  succeeded: number;
  /** Settled volume as a decimal string — never a float. */
  total: string;
}

const NO_ACTIVITY: CustomerPaymentStats = {
  payments: 0,
  succeeded: 0,
  total: '0',
};

/** The columns a wallet leaves this service with: every field `CustomerWalletEntity` documents. */
export const CUSTOMER_WALLET_PUBLIC_SELECT = {
  id: true,
  chain: true,
  address: true,
  label: true,
  createdAt: true,
} as const satisfies Prisma.CustomerWalletSelect;

/**
 * The columns a customer may leave this service with: every field
 * `CustomerEntity` documents, its wallets oldest first. Every read and write answered with the
 * full row before, `consumerId` included; an allowlist also keeps any column added later
 * in the table until someone lists it here.
 */
export const CUSTOMER_PUBLIC_SELECT = {
  id: true,
  name: true,
  alias: true,
  email: true,
  note: true,
  reference: true,
  createdAt: true,
  updatedAt: true,
  wallets: {
    select: CUSTOMER_WALLET_PUBLIC_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} as const satisfies Prisma.CustomerSelect;

type StoredCustomer = Prisma.CustomerGetPayload<{
  select: typeof CUSTOMER_PUBLIC_SELECT;
}>;

/** A wallet as it is stored: its chain, and the address in that chain's spelling. */
interface WalletInput {
  chain: Chain;
  address: string;
  label: string | null;
}

/**
 * A customer as it is answered: the row, plus `account`, the first wallet's address. A customer
 * held one account before it held wallets, and clients written then still read that field.
 */
function present(customer: StoredCustomer) {
  return { ...customer, account: customer.wallets[0]?.address ?? null };
}

function walletOf(dto: CustomerWalletDto): WalletInput {
  return {
    chain: dto.chain,
    address: normalizeAddress(dto.chain, dto.address),
    label: dto.label?.trim() || null,
  };
}

/**
 * The wallet a deprecated `account` names, its chain read from its shape. `IsAnyChainAddress`
 * already refused a shape no chain accepts.
 */
function legacyWallet(account: string): WalletInput {
  const chain = chainOfAddress(account);
  if (!chain) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'account is no chain’s address',
    );
  }
  return { chain, address: normalizeAddress(chain, account), label: null };
}

/** The same wallet named twice in one request is one wallet. */
function distinct(wallets: WalletInput[]): WalletInput[] {
  const seen = new Set<string>();
  return wallets.filter((w) => {
    const key = `${w.chain}:${w.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private resolveConsumer(consumer: GatewayConsumer) {
    return this.consumers.resolve(consumer);
  }

  async create(consumer: GatewayConsumer, dto: CreateCustomerDto) {
    const local = await this.resolveConsumer(consumer);
    const wallets = distinct([
      ...(dto.wallets ?? []).map(walletOf),
      ...(dto.account ? [legacyWallet(dto.account)] : []),
    ]);
    this.assertWithinCap(wallets.length);
    await this.assertWalletsFree(local.id, wallets);
    const customer = await this.claimingWallets(wallets, () =>
      this.prisma.customer.create({
        data: {
          consumerId: local.id,
          name: dto.name,
          alias: dto.alias ?? null,
          note: dto.note ?? null,
          email: dto.email ?? null,
          reference: dto.reference ?? null,
          wallets: {
            create: wallets.map((w) => ({ consumerId: local.id, ...w })),
          },
        },
        select: CUSTOMER_PUBLIC_SELECT,
      }),
    );
    return present(customer);
  }

  /**
   * Adds the payer of a settled payment to the consumer's customers, once per wallet.
   *
   * Payment intents call this on settlement; they used to write the row
   * themselves, into a table this module owns. Nothing is known about an
   * on-chain payer but the address, so the name is that address shortened and
   * `reference: 'auto'` marks the row as one the merchant never entered. A payer
   * whose wallet is already one of a customer's — however it got there — is left as it is,
   * and so is a payer another settlement added a moment ago (the wallet's unique index).
   *
   * Takes the local consumer id rather than a gateway consumer: the caller holds
   * a settled intent, which may be settling from the observer with no request
   * in sight.
   */
  async ensureForPayer(
    consumerId: string,
    chain: Chain,
    account: string,
  ): Promise<void> {
    const address = normalizeAddress(chain, account);
    const existing = await this.prisma.customerWallet.findFirst({
      where: { consumerId, chain, address },
      select: { id: true },
    });
    if (existing) return;
    try {
      await this.prisma.customer.create({
        data: {
          consumerId,
          name: `${address.slice(0, 6)}…${address.slice(-4)}`,
          reference: AUTO_CUSTOMER_REFERENCE,
          wallets: { create: [{ consumerId, chain, address }] },
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return;
      throw err;
    }
    this.logger.log(
      `Auto-created customer ${address} (${chain}) for consumer ${consumerId}`,
    );
  }

  async findAll(consumer: GatewayConsumer, query: QueryCustomersDto) {
    const local = await this.resolveConsumer(consumer);
    const where = { consumerId: local.id };

    // `total` is the row count, never `data.length` — the page size is `take`
    // on every full page, so a client paginating on it never sees the end.
    const [customers, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: CUSTOMER_PUBLIC_SELECT,
      }),
      this.prisma.customer.count({ where }),
    ]);

    const stats = await this.paymentStats(
      local.id,
      resolveNetwork(this.config, consumer),
      customers.filter((c) => c.wallets.length > 0).map((c) => c.id),
    );

    const data = customers.map((c) => {
      const s = stats.get(c.id) ?? NO_ACTIVITY;
      return {
        ...present(c),
        payments: s.payments,
        succeeded: s.succeeded,
        total: s.total,
      };
    });

    return { data, total, take: query.take, skip: query.skip };
  }

  /**
   * Per-customer payment stats for the customers on the current page, over all their wallets,
   * aggregated in PostgreSQL.
   *
   * This used to load every customer *and* every payment intent belonging to
   * the consumer on each request and tally them in JS: two unbounded reads to
   * produce three numbers per row, growing with the merchant's whole history.
   *
   * The counts alone would be a `groupBy`, but the settled volume cannot go
   * through `_sum`: `PaymentIntent.amount` is a `String` column (decimal
   * strings, so Stellar's 7-dp values stay exact) and Prisma will not sum text.
   * So the aggregate is one `$queryRaw` with a `::numeric` cast, summed per customer in the
   * database, so a customer with wallets on several chains is added up exactly too. Values are
   * parameterized; the customer list is bounded by the page size.
   *
   * A payment counts toward the wallet it was paid from on its own chain: payment intents
   * record a Monad payer EIP-55, as wallets are stored. Scoped to the network the caller's key
   * targets, like every other payment figure, so a sandbox key's customers do not count
   * mainnet payments, nor the reverse.
   */
  private async paymentStats(
    consumerId: string,
    network: string,
    customerIds: string[],
  ): Promise<Map<string, CustomerPaymentStats>> {
    if (customerIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.$queryRaw<
      {
        customer: string;
        payments: bigint;
        succeeded: bigint;
        total: unknown;
      }[]
    >`
      SELECT w."customerId" AS customer,
             COUNT(*) AS payments,
             COUNT(*) FILTER (WHERE p."status" = 'SUCCEEDED') AS succeeded,
             COALESCE(
               SUM(NULLIF(p."amount", '')::numeric)
                 FILTER (WHERE p."status" = 'SUCCEEDED'),
               0
             ) AS total
        FROM "customer_wallet" w
        JOIN "payment_intent" p
          ON p."consumerId" = w."consumerId"
         AND p."chain" = w."chain"
         AND p."source" = w."address"
       WHERE w."consumerId" = ${consumerId}
         AND w."customerId" IN (${Prisma.join(customerIds)})
         AND p."network" = ${network}
       GROUP BY w."customerId"
    `;

    return new Map(
      rows.map((r) => [
        r.customer,
        {
          payments: Number(r.payments),
          succeeded: Number(r.succeeded),
          total: formatNumericAmount(r.total),
        },
      ]),
    );
  }

  async findOne(consumer: GatewayConsumer, id: string) {
    const local = await this.resolveConsumer(consumer);
    return present(await this.owned(local.id, id));
  }

  /**
   * The customer's own fields. A deprecated `account` edits the first wallet, as it edited the
   * one account a customer held: an address replaces it (or adds one), null removes it.
   */
  async update(consumer: GatewayConsumer, id: string, dto: UpdateCustomerDto) {
    const local = await this.resolveConsumer(consumer);
    const current = await this.owned(local.id, id);
    if (dto.account !== undefined) {
      await this.setFirstWallet(local.id, current, dto.account);
    }
    const customer = await this.prisma.customer.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.alias !== undefined ? { alias: dto.alias } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.reference !== undefined ? { reference: dto.reference } : {}),
      },
      select: CUSTOMER_PUBLIC_SELECT,
    });
    return present(customer);
  }

  async remove(consumer: GatewayConsumer, id: string) {
    const local = await this.resolveConsumer(consumer);
    await this.owned(local.id, id);
    await this.prisma.customer.delete({ where: { id } });
    return { id, deleted: true };
  }

  /** Adds a wallet to a customer, on any chain payments settle on. */
  async addWallet(
    consumer: GatewayConsumer,
    id: string,
    dto: CustomerWalletDto,
  ) {
    const local = await this.resolveConsumer(consumer);
    const customer = await this.owned(local.id, id);
    const wallet = walletOf(dto);
    const held = customer.wallets.find(
      (w) => w.chain === wallet.chain && w.address === wallet.address,
    );
    // Adding a wallet the customer already holds changes nothing, so it answers the wallet.
    if (held) return held;
    this.assertWithinCap(customer.wallets.length + 1);
    await this.assertWalletsFree(local.id, [wallet]);
    return this.claimingWallets([wallet], () =>
      this.prisma.customerWallet.create({
        data: { consumerId: local.id, customerId: id, ...wallet },
        select: CUSTOMER_WALLET_PUBLIC_SELECT,
      }),
    );
  }

  async removeWallet(consumer: GatewayConsumer, id: string, walletId: string) {
    const local = await this.resolveConsumer(consumer);
    const customer = await this.owned(local.id, id);
    if (!customer.wallets.some((w) => w.id === walletId)) {
      throw ApiError.notFound('Wallet not found');
    }
    await this.prisma.customerWallet.delete({ where: { id: walletId } });
    return { id: walletId, deleted: true };
  }

  /**
   * One customer of this consumer, with its wallets. A miss on someone else's customer is the
   * 404 of a missing one.
   */
  private async owned(consumerId: string, id: string): Promise<StoredCustomer> {
    const customer = await this.prisma.customer.findFirst({
      where: { id, consumerId },
      select: CUSTOMER_PUBLIC_SELECT,
    });
    if (!customer) throw ApiError.notFound('Customer not found');
    return customer;
  }

  private async setFirstWallet(
    consumerId: string,
    customer: StoredCustomer,
    account: string | null,
  ): Promise<void> {
    const first = customer.wallets[0];
    if (account === null) {
      if (first) {
        await this.prisma.customerWallet.delete({ where: { id: first.id } });
      }
      return;
    }
    const wallet = legacyWallet(account);
    if (
      first &&
      first.chain === wallet.chain &&
      first.address === wallet.address
    ) {
      return;
    }
    await this.assertWalletsFree(consumerId, [wallet], customer.id);
    await this.claimingWallets([wallet], () =>
      first
        ? this.prisma.customerWallet.update({
            where: { id: first.id },
            data: { chain: wallet.chain, address: wallet.address },
          })
        : this.prisma.customerWallet.create({
            data: { consumerId, customerId: customer.id, ...wallet },
          }),
    );
  }

  private assertWithinCap(count: number): void {
    if (count > MAX_CUSTOMER_WALLETS) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `A customer holds at most ${MAX_CUSTOMER_WALLETS} wallets.`,
      );
    }
  }

  /**
   * Refuses a wallet another customer of this consumer already holds, naming it and that
   * customer, so the merchant can find the record that has it. `except` is the customer
   * being edited, whose own wallets are not a conflict.
   */
  private async assertWalletsFree(
    consumerId: string,
    wallets: WalletInput[],
    except?: string,
  ): Promise<void> {
    if (wallets.length === 0) return;
    const taken = await this.prisma.customerWallet.findFirst({
      where: {
        consumerId,
        OR: wallets.map((w) => ({ chain: w.chain, address: w.address })),
        ...(except ? { customerId: { not: except } } : {}),
      },
      select: { chain: true, address: true, customerId: true },
    });
    if (taken) throw this.walletTaken(taken);
  }

  /**
   * Runs a write that adds wallets, turning the unique index's refusal (a wallet another
   * request claimed between the check and the write) into the same 409.
   */
  private async claimingWallets<T>(
    wallets: WalletInput[],
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const [w] = wallets;
      throw ApiError.conflict(
        ApiErrorCode.CustomerWalletTaken,
        w
          ? `The wallet ${w.address} (${w.chain}) already belongs to another customer.`
          : 'That wallet already belongs to another customer.',
      );
    }
  }

  private walletTaken(taken: {
    chain: string;
    address: string;
    customerId: string;
  }): ApiError {
    return ApiError.conflict(
      ApiErrorCode.CustomerWalletTaken,
      `The wallet ${taken.address} (${taken.chain}) already belongs to customer ${taken.customerId}.`,
    );
  }
}
