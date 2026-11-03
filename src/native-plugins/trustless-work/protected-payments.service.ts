import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ProtectedPayment } from '@generated/prisma/client';
import { ASSET_REGISTRY } from '@/assets/assets.constants';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { type Page, page } from '@/common/pagination';
import { isUniqueViolation } from '@/common/prisma-errors';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { resolveNetwork } from '@/common/stellar-network';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { resolveIdempotencyKey } from '@/stellar/stellar-operation-policy';
import { fromStroops, toStroops } from '@/swaps/swap-math';
import type {
  CreateProtectedPaymentDto,
  QueryProtectedPaymentsDto,
} from '@/native-plugins/trustless-work/dto/protected-payment.dto';
import {
  type BuiltTransaction,
  ProtectedPaymentActionsService,
  type SubmittedTransaction,
} from '@/native-plugins/trustless-work/protected-payment-actions.service';
import { ProtectedPaymentLifecycle } from '@/native-plugins/trustless-work/protected-payment-lifecycle.service';
import { ProtectedPaymentTransactionsService } from '@/native-plugins/trustless-work/protected-payment-transactions.service';
import {
  type MerchantView,
  merchantView,
  PROTECTED_PAYMENT_PUBLIC_SELECT,
} from '@/native-plugins/trustless-work/protected-payment-views';
import {
  PROTECTED_PAYMENT_ASSET_CODE,
  PROTECTED_PAYMENT_DEFAULT_FUNDING_HOURS,
  PROTECTED_PAYMENT_MAX_AMOUNT,
  PROTECTED_PAYMENT_MIN_AMOUNT,
} from '@/native-plugins/trustless-work/trustless-work.constants';
import { TrustlessWorkKeys } from '@/native-plugins/trustless-work/trustless-work-keys';
import { trustlessWorkEnvName } from '@/native-plugins/trustless-work/trustless-work-config';

/** A build, as the merchant's routes answer it. */
export type MerchantBuild = Omit<BuiltTransaction, 'payment'> & {
  protectedPayment: MerchantView;
};

/** A relay, as the merchant's routes answer it. */
export type MerchantSubmit = Omit<SubmittedTransaction, 'payment'> & {
  protectedPayment: MerchantView;
};

/** The terms a replayed create is compared on. */
const REPLAY_TERMS = [
  'network',
  'amount',
  'releaseModel',
  'deadlinePolicy',
  'deliveryWindowHours',
  'merchantAddress',
  'buyerAddress',
  'title',
  'description',
  'reference',
] as const satisfies readonly (keyof ProtectedPayment)[];

/**
 * The merchant's protected payments, on the network of the merchant's API key:
 * create, read, list, and the merchant's own actions (ship, approve, release,
 * dispute, cancel, submit). Every query filters by the calling consumer AND the
 * key's network (`resolveNetwork`); a miss on anyone else's row is the 404 of a
 * missing one.
 */
@Injectable()
export class ProtectedPaymentsService {
  private readonly logger = new Logger(ProtectedPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly keys: TrustlessWorkKeys,
    private readonly actions: ProtectedPaymentActionsService,
    private readonly transactions: ProtectedPaymentTransactionsService,
    private readonly lifecycle: ProtectedPaymentLifecycle,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Creates a protected payment. No chain action: the contract is deployed
   * when the buyer first funds it. Refused `503 misconfigured` when the
   * network has no Trustless Work key or platform key, or the deadline policy
   * no resolver. The same `Idempotency-Key` with the same terms returns the
   * stored payment; with other terms it is `409 idempotency_conflict`.
   */
  async create(
    consumer: GatewayConsumer,
    dto: CreateProtectedPaymentDto,
    headerIdempotencyKey?: string,
  ): Promise<MerchantView> {
    const network = resolveNetwork(this.config, consumer);
    this.assertConfigured(network);
    const platform = this.keys.platform(network).publicKey();
    const disputeResolver = this.keys.disputeResolverFor(
      network,
      dto.deadlinePolicy,
    );
    const amount = this.normalizedAmount(dto.amount);
    this.assertParties(network, dto.merchantAddress, dto.buyerAddress);

    const local = await this.consumers.resolve(consumer);
    const idempotencyKey = resolveIdempotencyKey(
      headerIdempotencyKey,
      dto.idempotencyKey,
    );
    const terms: Pick<ProtectedPayment, (typeof REPLAY_TERMS)[number]> = {
      network,
      amount,
      releaseModel: dto.releaseModel,
      deadlinePolicy: dto.deadlinePolicy,
      deliveryWindowHours: dto.deliveryWindowHours,
      merchantAddress: dto.merchantAddress,
      buyerAddress: dto.buyerAddress ?? null,
      title: dto.title,
      description: dto.description ?? null,
      reference: dto.reference ?? null,
    };
    if (idempotencyKey) {
      const existing = await this.prisma.protectedPayment.findUnique({
        where: {
          consumerId_idempotencyKey: { consumerId: local.id, idempotencyKey },
        },
      });
      if (existing) return this.replay(existing, terms, consumer);
    }

    const fundingHours =
      dto.fundingWindowHours ?? PROTECTED_PAYMENT_DEFAULT_FUNDING_HOURS;
    let row: ProtectedPayment;
    try {
      row = await this.prisma.protectedPayment.create({
        data: {
          ...terms,
          consumerId: local.id,
          asset: PROTECTED_PAYMENT_ASSET_CODE,
          assetIssuer: usdcIssuer(network),
          platformAddress: platform,
          disputeResolverAddress: disputeResolver,
          platformFeeBps: this.config.get('trustlessWork', { infer: true })
            .platformFeeBps,
          idempotencyKey,
          fundingExpiresAt: new Date(Date.now() + fundingHours * 3_600_000),
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error) || !idempotencyKey) throw error;
      const raced = await this.prisma.protectedPayment.findUnique({
        where: {
          consumerId_idempotencyKey: { consumerId: local.id, idempotencyKey },
        },
      });
      if (!raced) throw error;
      return this.replay(raced, terms, consumer);
    }
    this.logger.log(
      `Created protected payment ${row.id}: ${row.amount} USDC on ${network} ` +
        `(${row.releaseModel}, ${row.deadlinePolicy}, consumer=${consumer.username})`,
    );
    await this.lifecycle.created(row);
    return this.view(row);
  }

  /** The key's protected payments on its network, newest first. */
  async findAll(
    consumer: GatewayConsumer,
    query: QueryProtectedPaymentsDto,
  ): Promise<Page<MerchantView>> {
    const where = {
      consumerId: await this.consumers.resolveId(consumer),
      network: resolveNetwork(this.config, consumer),
      ...(query.status ? { status: query.status } : {}),
    };
    // `Promise.all`, not `$transaction`: see `@/common/pagination` for why.
    const [rows, total] = await Promise.all([
      this.prisma.protectedPayment.findMany({
        where,
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
        select: PROTECTED_PAYMENT_PUBLIC_SELECT,
      }),
      this.prisma.protectedPayment.count({ where }),
    ]);
    return page(
      rows.map((row) => merchantView(row, this.checkoutOrigin())),
      total,
      query,
    );
  }

  async findOne(consumer: GatewayConsumer, id: string): Promise<MerchantView> {
    return this.view(await this.findOwned(consumer, id));
  }

  async ship(
    consumer: GatewayConsumer,
    id: string,
    evidence: string,
  ): Promise<MerchantBuild> {
    const row = await this.findOwned(consumer, id);
    return this.buildView(await this.actions.ship(row, evidence));
  }

  async approve(consumer: GatewayConsumer, id: string): Promise<MerchantBuild> {
    const row = await this.findOwned(consumer, id);
    return this.buildView(await this.actions.approve(row, 'MERCHANT'));
  }

  async release(consumer: GatewayConsumer, id: string): Promise<MerchantBuild> {
    const row = await this.findOwned(consumer, id);
    return this.buildView(await this.actions.release(row, 'MERCHANT'));
  }

  /** The merchant always holds a role, so it always signs its own dispute. */
  async dispute(
    consumer: GatewayConsumer,
    id: string,
    reason: string | null,
  ): Promise<MerchantBuild> {
    const row = await this.findOwned(consumer, id);
    const outcome = await this.actions.dispute(row, 'MERCHANT', reason);
    if (!outcome.built) {
      throw new Error(`A merchant dispute of ${id} was not handed out to sign`);
    }
    return this.buildView(outcome.built);
  }

  /**
   * Cancels a payment nobody funded: CREATED, or AWAITING_FUNDING with an
   * empty contract and no deposit still able to land (one handed out and
   * unexpired is `409 operation_in_flight`: retry when it lapses).
   */
  async cancel(consumer: GatewayConsumer, id: string): Promise<MerchantView> {
    const row = await this.findOwned(consumer, id);
    if (row.status !== 'CREATED' && row.status !== 'AWAITING_FUNDING') {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Cannot cancel a protected payment that is ${row.status}: only one ` +
          'nobody funded can be cancelled.',
      );
    }
    if (await this.transactions.outstanding(row.id, 'FUND', new Date())) {
      throw ApiError.conflict(
        ApiErrorCode.OperationInFlight,
        'The buyer holds a deposit for this protected payment that can still ' +
          'land. Retry once it expires (15 minutes at most).',
      );
    }
    if (row.contractId && (await this.actions.balanceOf(row)) > 0n) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        'Cannot cancel a protected payment whose contract holds funds.',
      );
    }
    const cancelled = await this.lifecycle.step(row.id, 'CANCELLED');
    return this.view(cancelled ?? (await this.findOwned(consumer, id)));
  }

  /** Relays a merchant-signed transaction built for one of the key's payments. */
  async submit(
    consumer: GatewayConsumer,
    protectedPaymentId: string,
    xdr: string,
  ): Promise<MerchantSubmit> {
    const row = await this.findOwned(consumer, protectedPaymentId);
    const submitted = await this.actions.submit(
      row,
      { consumerId: row.consumerId, signer: row.merchantAddress },
      xdr,
    );
    const { payment, ...rest } = submitted;
    return { ...rest, protectedPayment: this.view(payment) };
  }

  private async findOwned(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<ProtectedPayment> {
    const row = await this.prisma.protectedPayment.findFirst({
      where: {
        id,
        consumerId: await this.consumers.resolveId(consumer),
        network: resolveNetwork(this.config, consumer),
      },
    });
    if (!row) throw ApiError.notFound(`Protected payment ${id} not found`);
    return row;
  }

  private replay(
    existing: ProtectedPayment,
    terms: Pick<ProtectedPayment, (typeof REPLAY_TERMS)[number]>,
    consumer: GatewayConsumer,
  ): MerchantView {
    const same = REPLAY_TERMS.every((key) => existing[key] === terms[key]);
    if (!same) {
      this.logger.warn(
        'Idempotency-Key reused for a different protected payment ' +
          `(payment=${existing.id}, consumer=${consumer.username})`,
      );
      throw ApiError.conflict(
        ApiErrorCode.IdempotencyConflict,
        'This Idempotency-Key was already used for a different protected ' +
          'payment. Use a new key for a new request.',
      );
    }
    return this.view(existing);
  }

  private assertConfigured(network: StellarNetwork): void {
    if (!this.keys.isConfigured(network)) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        `Protected payments are not configured on ${network}: set ` +
          `${trustlessWorkEnvName(network, 'API_KEY')} and ` +
          `${trustlessWorkEnvName(network, 'PLATFORM_SECRET')}.`,
      );
    }
  }

  /** The amount as stored: 7-decimal canonical, within the product's bounds. */
  private normalizedAmount(amount: string): string {
    const stroops = toStroops(amount);
    if (
      stroops < toStroops(PROTECTED_PAYMENT_MIN_AMOUNT) ||
      stroops > toStroops(PROTECTED_PAYMENT_MAX_AMOUNT)
    ) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        `amount must be from ${PROTECTED_PAYMENT_MIN_AMOUNT} to ` +
          `${PROTECTED_PAYMENT_MAX_AMOUNT} USDC`,
      );
    }
    return fromStroops(stroops);
  }

  /**
   * The merchant and a named buyer are two accounts, and neither is one the
   * platform acts as: a party that is also the platform or a resolver would
   * hold two roles the contract keeps apart.
   */
  private assertParties(
    network: StellarNetwork,
    merchant: string,
    buyer: string | undefined,
  ): void {
    if (buyer && buyer === merchant) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'buyerAddress and merchantAddress must be different accounts',
      );
    }
    const server = this.keys.serverAccounts(network);
    if (server.includes(merchant) || (buyer && server.includes(buyer))) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'The merchant and the buyer cannot be one of the platform accounts',
      );
    }
  }

  private buildView(built: BuiltTransaction): MerchantBuild {
    const { payment, ...rest } = built;
    return { ...rest, protectedPayment: this.view(payment) };
  }

  private view(row: ProtectedPayment): MerchantView {
    return merchantView(row, this.checkoutOrigin());
  }

  private checkoutOrigin(): string {
    return this.config.get('paymentIntents', { infer: true }).checkoutUrl;
  }
}

/**
 * The USDC issuer the asset registry vouches for on `network` (Circle's). The
 * registry is the identity of an asset here: every other `USDC` is a look-alike.
 */
export function usdcIssuer(network: StellarNetwork): string {
  const usdc = ASSET_REGISTRY[network].find(
    (asset) =>
      asset.code === PROTECTED_PAYMENT_ASSET_CODE &&
      asset.verified &&
      asset.issuer,
  );
  if (!usdc?.issuer) {
    throw ApiError.unavailable(
      ApiErrorCode.Misconfigured,
      `The asset registry lists no verified USDC on ${network}.`,
    );
  }
  return usdc.issuer;
}
