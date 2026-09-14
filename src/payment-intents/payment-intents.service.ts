import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Asset,
  Memo,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { AppConfig, StellarNetwork } from '@/config/configuration';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { isUniqueViolation } from '@/common/prisma-errors';
import { resolveNetwork } from '@/common/stellar-network';
import { PrismaService } from '@/prisma/prisma.service';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { StellarService } from '@/stellar/stellar.service';
import type {
  PaymentIntent,
  PaymentIntentStatus,
  PaymentIntentTransition,
  WebhookEventType,
} from '@generated/prisma/client';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import { CreateTxPaymentIntentDto } from '@/payment-intents/dto/create-tx-payment-intent.dto';
import { CreatePayPaymentIntentDto } from '@/payment-intents/dto/create-pay-payment-intent.dto';
import { QueryPaymentIntentsDto } from '@/payment-intents/dto/query-payment-intents.dto';
import { UpdatePaymentIntentDto } from '@/payment-intents/dto/update-payment-intent.dto';
import {
  assertTransition,
  InvalidPaymentIntentTransitionError,
  isTerminalStatus,
} from '@/payment-intents/payment-intent-state-machine';
import {
  isSameIntentRequest,
  type PaymentIntentTerms,
} from '@/payment-intents/payment-intent-replay';
import { StellarVerifierService } from '@/payment-intents/stellar-verifier.service';

/** Who triggered a status change — stored on the audit row. */
export type PaymentIntentTransitionActor =
  'api' | 'validate' | 'observer' | 'system';

export interface TransitionOptions {
  consumerUsername: string;
  actor: PaymentIntentTransitionActor;
  reason?: string;
  txHash?: string;
  /** On-chain payer for PAY intents settled by observer/validate. */
  payer?: string;
}

export interface ValidationOutcome {
  valid: boolean;
  status: PaymentIntentStatus;
  reason?: string;
  paymentIntent?: PaymentIntentView;
}

// A stored intent plus its (derived) QR code — what API responses return.
export type PaymentIntentView = PaymentIntent & { qr: string };

@Injectable()
export class PaymentIntentsService {
  private readonly logger = new Logger(PaymentIntentsService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookTerminalEmitter,
    private readonly verifier: StellarVerifierService,
    private readonly stellar: StellarService,
    private readonly consumers: ConsumerResolverService,
  ) {}

  /**
   * The Stellar network is dictated by the caller's API key type, forwarded by
   * the gateway: `prod` key → public, `dev` key → testnet. Falls back to the
   * configured default only when the gateway didn't forward an environment
   * (local dev without APISIX).
   */
  private resolveNetwork(consumer: GatewayConsumer): StellarNetwork {
    return resolveNetwork(this.config, consumer);
  }

  /**
   * Emits a domain event the webhook dispatcher fans out to integrators.
   *
   * Everything goes through {@link WebhookTerminalEmitter} rather than straight
   * onto the in-memory bus. For PAYMENT_INTENT_SUCCEEDED / _FAILED that is what
   * makes the notification durable: the emitter writes the `webhook_delivery`
   * rows inside its own transaction *before* the bus sees the event, so a pod
   * killed mid-notification leaves work the delivery sweeper can finish. Without
   * it, a crash between the settled status and the bus listener lost the
   * settlement notification permanently, with nothing to retry from.
   *
   * Non-terminal events (CREATED / UPDATED / CANCELLED / DELETED) short-circuit
   * inside `emit` straight to the bus, so routing them here costs nothing and
   * keeps one emission path for the module.
   *
   * @returns `false` when a prior claim already notified — impossible for an
   * intent today (see the transition graph: SUCCEEDED and FAILED are absorbing,
   * and the status change is a compare-and-swap only one writer wins), so
   * callers do not branch on it.
   */
  private emit(
    consumerUsername: string,
    type: WebhookEventType,
    data: PaymentIntent,
  ): Promise<boolean> {
    return this.webhooks.emit(consumerUsername, type, data);
  }

  /** Maps a status change to the matching webhook event type. */
  private statusEvent(status: PaymentIntentStatus): WebhookEventType {
    switch (status) {
      case 'SUCCEEDED':
        return 'PAYMENT_INTENT_SUCCEEDED';
      case 'FAILED':
        return 'PAYMENT_INTENT_FAILED';
      case 'CANCELLED':
        return 'PAYMENT_INTENT_CANCELLED';
      default:
        return 'PAYMENT_INTENT_UPDATED';
    }
  }

  /**
   * Ensures a local Consumer row mirrors the APISIX consumer that authenticated
   * the request. Every payment intent is scoped to this record.
   */
  private resolveConsumer(consumer: GatewayConsumer) {
    return this.consumers.resolve(consumer);
  }

  /** QR is derived from the stored SEP-7 URI rather than persisted. */
  private async withQr(intent: PaymentIntent): Promise<PaymentIntentView> {
    return { ...intent, qr: await QRCode.toDataURL(intent.uri) };
  }

  /**
   * Resolves the requested asset. No code (or "XLM"/"native") → native lumens;
   * any other code requires an issuer. Returns both the stored representation
   * and the SDK Asset for building transactions.
   */
  private resolveAsset(
    assetCode?: string,
    assetIssuer?: string,
  ): {
    code: string;
    issuer: string | null;
    asset: Asset;
  } {
    const code = assetCode?.trim();
    if (
      !code ||
      code.toLowerCase() === 'xlm' ||
      code.toLowerCase() === 'native'
    ) {
      return { code: 'native', issuer: null, asset: Asset.native() };
    }
    if (!assetIssuer) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `assetIssuer is required for non-native asset "${code}"`,
      );
    }
    return { code, issuer: assetIssuer, asset: new Asset(code, assetIssuer) };
  }

  /**
   * The memo is a mandatory MEMO_ID: it identifies the payment on-chain and
   * gives the intent idempotency. Validates a provided id (numeric, uint64) or
   * generates a random one.
   */
  private resolveMemo(provided?: string): string {
    if (provided !== undefined) {
      if (!/^\d+$/.test(provided) || BigInt(provided) > 18446744073709551615n) {
        throw ApiError.badRequest(
          ApiErrorCode.InvalidMemo,
          'memo must be a MEMO_ID: a numeric uint64 string',
        );
      }
      return provided;
    }
    // Random uint64 (8 bytes) as a decimal string.
    return BigInt('0x' + randomBytes(8).toString('hex')).toString();
  }

  /** Idempotency: return the existing intent for (consumer, memo), if any. */
  private async findByMemo(
    consumerId: string,
    memo: string,
  ): Promise<PaymentIntent | null> {
    return this.prisma.paymentIntent.findUnique({
      where: { consumerId_memo: { consumerId, memo } },
    });
  }

  /**
   * Resolves a create that landed on an existing `(consumer, memo)`: the stored
   * intent when the request describes the same payment, a 409 when it does not.
   * {@link isSameIntentRequest} explains why a matching memo is not enough.
   *
   * `stored` is null only on the race path, when the row that beat this
   * request's insert was deleted again before it could be read back.
   */
  private replayOf(
    stored: PaymentIntent | null,
    terms: PaymentIntentTerms,
  ): Promise<PaymentIntentView> {
    if (!stored) {
      throw ApiError.conflict(
        ApiErrorCode.OperationInFlight,
        'A concurrent request for this memo changed it while this one was ' +
          'being created. Retry the request.',
      );
    }
    if (!isSameIntentRequest(stored, terms)) {
      // Names nothing about the stored intent. Under the shared public key it
      // may be another caller's, and saying which term differed would let a
      // caller recover that intent one field at a time.
      throw ApiError.conflict(
        ApiErrorCode.IdempotencyConflict,
        'A payment intent with this memo already exists for different payment ' +
          'details. Retry with the original request unchanged, or use a new ' +
          'memo (omit it to have one generated).',
      );
    }
    return this.withQr(stored);
  }

  /** Appends shared SEP-7 extras (`msg`, `callback`) to a URI's params. */
  private appendSep7Extras(
    params: URLSearchParams,
    extras: { msg?: string; callback?: string },
  ): void {
    if (extras.callback) params.set('callback', extras.callback);
    if (extras.msg) params.set('msg', extras.msg);
  }

  // ── CREATE: tx ──────────────────────────────────────────────────────────────
  /**
   * SEP-7 `tx`: build the unsigned TransactionEnvelope from a known `source` and
   * return its XDR + `web+stellar:tx?xdr=...` URI + QR for the wallet to sign.
   * Network is dictated by the caller's API key type.
   */
  async createTx(
    consumer: GatewayConsumer,
    dto: CreateTxPaymentIntentDto,
  ): Promise<PaymentIntentView> {
    const stellar = this.config.get('stellar', { infer: true });
    const network = this.resolveNetwork(consumer);
    const localConsumer = await this.resolveConsumer(consumer);
    const asset = this.resolveAsset(dto.assetCode, dto.assetIssuer);
    const memo = this.resolveMemo(dto.memo);
    const terms: PaymentIntentTerms = {
      kind: 'TX',
      network,
      source: dto.source,
      destination: dto.destination,
      amount: dto.amount,
      asset: asset.code,
      assetIssuer: asset.issuer,
      msg: dto.msg ?? null,
      callback: dto.callback ?? null,
    };

    // Idempotency: a retry on the same (consumer, memo) returns the original
    // intent before any Horizon round trip — but only for the same payment.
    const existing = await this.findByMemo(localConsumer.id, memo);
    if (existing) return this.replayOf(existing, terms);

    const account = await this.loadAccount(network, dto.source);
    const xdr = new TransactionBuilder(account, {
      fee: stellar.baseFee,
      networkPassphrase: this.stellar.passphrase(network),
    })
      .addOperation(
        Operation.payment({
          destination: dto.destination,
          amount: dto.amount,
          asset: asset.asset,
        }),
      )
      .addMemo(Memo.id(memo))
      .setTimeout(stellar.timeoutSeconds)
      .build()
      .toXDR();

    // SEP-7 tx URI: xdr (required) + optional msg/callback.
    const params = new URLSearchParams({ xdr });
    this.appendSep7Extras(params, { msg: dto.msg, callback: dto.callback });
    const uri = `web+stellar:tx?${params.toString()}`;

    const intent = await this.persist({
      ...terms,
      consumerId: localConsumer.id,
      memo,
      status: 'PENDING',
      xdr,
      uri,
    });
    if (!intent) {
      return this.replayOf(
        await this.findByMemo(localConsumer.id, memo),
        terms,
      );
    }

    this.logger.log(
      `Created TX payment intent ${intent.id}: ${dto.amount} ` +
        `${asset.code === 'native' ? 'XLM' : asset.code} ${dto.source} → ${dto.destination} ` +
        `(consumer=${consumer.username}, network=${network}, memo=${memo})`,
    );
    await this.emit(consumer.username, 'PAYMENT_INTENT_CREATED', intent);
    return this.withQr(intent);
  }

  // ── CREATE: pay ─────────────────────────────────────────────────────────────
  /**
   * SEP-7 `pay`: no source/XDR — return a `web+stellar:pay?destination=...` URI
   * carrying the destination and any optional payment fields, plus a QR.
   */
  async createPay(
    consumer: GatewayConsumer,
    dto: CreatePayPaymentIntentDto,
  ): Promise<PaymentIntentView> {
    const network = this.resolveNetwork(consumer);
    const localConsumer = await this.resolveConsumer(consumer);
    const asset = this.resolveAsset(dto.assetCode, dto.assetIssuer);
    const memo = this.resolveMemo(dto.memo);
    const terms: PaymentIntentTerms = {
      kind: 'PAY',
      network,
      source: null,
      destination: dto.destination,
      amount: dto.amount ?? null,
      asset: asset.code,
      assetIssuer: asset.issuer,
      msg: dto.msg ?? null,
      callback: dto.callback ?? null,
    };

    const existing = await this.findByMemo(localConsumer.id, memo);
    if (existing) return this.replayOf(existing, terms);

    const params = new URLSearchParams({ destination: dto.destination });
    if (dto.amount) params.set('amount', dto.amount);
    if (asset.code !== 'native') {
      params.set('asset_code', asset.code);
      if (asset.issuer) params.set('asset_issuer', asset.issuer);
    }
    params.set('memo', memo);
    params.set('memo_type', 'MEMO_ID');
    this.appendSep7Extras(params, { msg: dto.msg, callback: dto.callback });
    const uri = `web+stellar:pay?${params.toString()}`;

    const intent = await this.persist({
      ...terms,
      consumerId: localConsumer.id,
      memo,
      status: 'PENDING',
      xdr: null,
      uri,
    });
    if (!intent) {
      return this.replayOf(
        await this.findByMemo(localConsumer.id, memo),
        terms,
      );
    }

    this.logger.log(
      `Created PAY payment intent ${intent.id}: ${dto.amount ?? '(open)'} ` +
        `${asset.code === 'native' ? 'XLM' : asset.code} → ${dto.destination} ` +
        `(consumer=${consumer.username}, network=${network}, memo=${memo})`,
    );
    await this.emit(consumer.username, 'PAYMENT_INTENT_CREATED', intent);
    return this.withQr(intent);
  }

  /**
   * Persists a new intent. Returns null on a (consumer, memo) unique-violation
   * race so the caller can put the winning row through the same replay check
   * as any other retry — losing the race is not a way around it.
   */
  private async persist(
    data: Parameters<PrismaService['paymentIntent']['create']>[0]['data'],
  ): Promise<PaymentIntent | null> {
    // Stamp the lifetime so the observer can expire unpaid intents.
    const ttlSeconds = this.config.get('paymentIntents', {
      infer: true,
    }).ttlSeconds;
    const withTtl = {
      ...data,
      expiresAt: data.expiresAt ?? new Date(Date.now() + ttlSeconds * 1000),
    };
    try {
      return await this.prisma.paymentIntent.create({ data: withTtl });
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  // ── READ (list) ─────────────────────────────────────────────────────────────
  async findAll(
    consumer: GatewayConsumer,
    query: QueryPaymentIntentsDto,
  ): Promise<{
    data: PaymentIntent[];
    total: number;
    take: number;
    skip: number;
  }> {
    const where = {
      consumer: { apisixUsername: consumer.username },
      ...(query.status ? { status: query.status } : {}),
    };

    // `Promise.all`, not `$transaction`: a snapshot-consistent page and count
    // buys nothing here (the client sees a moving list either way), while the
    // transaction costs four serial round trips — BEGIN, page, count, COMMIT —
    // instead of two issued in parallel.
    const [data, total] = await Promise.all([
      this.prisma.paymentIntent.findMany({
        where,
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.paymentIntent.count({ where }),
    ]);

    return { data, total, take: query.take, skip: query.skip };
  }

  // ── READ (one) ──────────────────────────────────────────────────────────────
  async findOne(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<PaymentIntentView> {
    const intent = await this.prisma.paymentIntent.findFirst({
      where: { id, consumer: { apisixUsername: consumer.username } },
    });

    if (!intent) {
      throw ApiError.notFound(`Payment intent ${id} not found`);
    }
    return this.withQr(intent);
  }

  // ── UPDATE ────────────────────────────────────────────────────────────────
  async update(
    consumer: GatewayConsumer,
    id: string,
    dto: UpdatePaymentIntentDto,
  ): Promise<PaymentIntentView> {
    // Authorize ownership before mutating.
    await this.assertOwned(consumer, id);

    // Settling from the API requires the chain to agree.
    //
    // The state machine's only evidence rule for SUCCEEDED is "txHash is a
    // non-empty string", which is a formatting check, not a proof. A
    // `payments:write` key could PATCH `{status:'SUCCEEDED', txHash:'x'}` and
    // mint a settled payment: the terminal webhook fires, the row is counted in
    // the merchant's balances and in the platform-wide admin volume figure, and
    // SUCCEEDED has no outgoing transitions so it never self-corrects.
    //
    // Route it through the same verifier `POST /:id/validate` uses — Horizon
    // lookup by hash, exact-stroop amount match, memo match, `tx.successful`.
    // The internal callers (observer, validate, expiry) still reach
    // `transition` directly; they already hold a verified hash.
    if (dto.status === 'SUCCEEDED') {
      return this.settleFromApi(consumer, id, dto);
    }

    // Every other status change goes through the single guarded entry point.
    if (dto.status) {
      const updated = await this.transition(id, dto.status, {
        consumerUsername: consumer.username,
        actor: 'api',
        reason: 'PATCH /payment-intents/:id',
        txHash: dto.txHash,
      });
      // Non-status fields can still be patched alongside a status change.
      if (dto.reference !== undefined && dto.reference !== updated.reference) {
        const patched = await this.prisma.paymentIntent.update({
          where: { id },
          data: { reference: dto.reference },
        });
        return this.withQr(patched);
      }
      return this.withQr(updated);
    }

    const updated =
      dto.txHash !== undefined
        ? await this.patchTxHash(id, dto.txHash, dto.reference)
        : await this.prisma.paymentIntent.update({
            where: { id },
            data: {
              ...(dto.reference !== undefined
                ? { reference: dto.reference }
                : {}),
            },
          });

    this.logger.log(
      `Updated payment intent ${id} (consumer=${consumer.username}): status unchanged`,
    );

    await this.emit(consumer.username, 'PAYMENT_INTENT_UPDATED', updated);
    return this.withQr(updated);
  }

  /**
   * Records a reported `txHash` (and any `reference` sent with it) without a
   * status change. Only a PENDING or SUBMITTED intent accepts a new hash.
   *
   * This branch had no status check, so a terminal intent's hash could be
   * rewritten: a SUCCEEDED row's `txHash` — the transaction its settlement was
   * verified against — swapped for any string, with no transition, no audit row,
   * and a PAYMENT_INTENT_UPDATED webhook broadcasting the new value. The write
   * is a compare-and-swap on the status just read, as in {@link transition}, so
   * an intent that settles in between is refused rather than overwritten.
   * Re-sending the hash the intent already carries changes nothing and stays
   * allowed, so a retried PATCH does not start failing once the intent settles.
   */
  private async patchTxHash(
    id: string,
    txHash: string,
    reference: string | undefined,
  ): Promise<PaymentIntent> {
    const data = {
      txHash,
      ...(reference !== undefined ? { reference } : {}),
    };
    const current = await this.prisma.paymentIntent.findUnique({
      where: { id },
      select: { status: true, txHash: true },
    });
    if (!current) {
      throw ApiError.notFound(`Payment intent ${id} not found`);
    }
    if (current.txHash === txHash) {
      return this.prisma.paymentIntent.update({ where: { id }, data });
    }
    if (isTerminalStatus(current.status)) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `txHash cannot be changed on a ${current.status} payment intent: ` +
          'the status is terminal',
      );
    }

    const guarded = await this.prisma.paymentIntent.updateMany({
      where: { id, status: current.status },
      data,
    });
    if (guarded.count === 0) {
      throw ApiError.conflict(
        ApiErrorCode.OperationInFlight,
        `Payment intent ${id} status changed concurrently; expected ${current.status}`,
      );
    }
    return this.prisma.paymentIntent.findUniqueOrThrow({ where: { id } });
  }

  /**
   * The API-driven SUCCEEDED path: verify against the chain, then settle.
   *
   * Delegates to {@link validate}, so a PATCH and a `POST /:id/validate` cannot
   * disagree about what counts as settled. A hash the chain does not corroborate
   * is a 400 rather than a silent settlement.
   */
  private async settleFromApi(
    consumer: GatewayConsumer,
    id: string,
    dto: UpdatePaymentIntentDto,
  ): Promise<PaymentIntentView> {
    const current = await this.prisma.paymentIntent.findUnique({
      where: { id },
    });
    if (!current) {
      throw ApiError.notFound(`Payment intent ${id} not found`);
    }

    // The declared graph and the evidence rule are checked here, before any
    // Horizon call: forcing a terminal intent to SUCCEEDED is an invalid
    // transition whatever the chain says, and it must not cost a network round
    // trip or report itself as a rejected transaction. `transition` applies the
    // same assertion again downstream — this is the early, honest error.
    try {
      assertTransition(current.status, 'SUCCEEDED', { txHash: dto.txHash });
    } catch (err) {
      if (err instanceof InvalidPaymentIntentTransitionError) {
        throw ApiError.badRequest(
          ApiErrorCode.InvalidStateTransition,
          err.message,
        );
      }
      throw err;
    }

    const outcome = await this.validate(consumer, id, dto.txHash!.trim());
    if (!outcome.valid) {
      throw ApiError.badRequest(
        ApiErrorCode.TransactionRejected,
        `The transaction does not settle this payment intent: ${
          outcome.reason ?? 'verification failed'
        }`,
      );
    }

    // `reference` may be patched alongside the settlement.
    if (dto.reference !== undefined) {
      const patched = await this.prisma.paymentIntent.update({
        where: { id },
        data: { reference: dto.reference },
      });
      return this.withQr(patched);
    }
    return outcome.paymentIntent!;
  }

  /**
   * Single status-transition entry point for payment intents (issue #36).
   * Validates the declared graph, requires on-chain evidence for SUCCEEDED,
   * applies an optimistic `status` guard in the UPDATE, and appends an audit row.
   */
  async transition(
    intentId: string,
    to: PaymentIntentStatus,
    opts: TransitionOptions,
  ): Promise<PaymentIntent> {
    const current = await this.prisma.paymentIntent.findUnique({
      where: { id: intentId },
    });
    if (!current) {
      throw ApiError.notFound(`Payment intent ${intentId} not found`);
    }

    const from = current.status;
    const toStatus = to;
    const txHash = opts.txHash ?? current.txHash ?? undefined;

    try {
      assertTransition(from, toStatus, { txHash });
    } catch (err) {
      if (err instanceof InvalidPaymentIntentTransitionError) {
        // `from`/`to` were never reachable by an integrator — the exception
        // filter only forwards statusCode/code/error/message — so they move
        // into the message, which already names both ends of the transition.
        throw ApiError.badRequest(
          ApiErrorCode.InvalidStateTransition,
          err.message,
        );
      }
      throw err;
    }

    // For PAY intents the payer is unknown until settlement — record the actual
    // on-chain source so the payment is attributable (and customer stats line up).
    const setSource =
      opts.payer && !current.source ? { source: opts.payer } : {};

    const updated = await this.prisma.$transaction(async (tx) => {
      const guarded = await tx.paymentIntent.updateMany({
        where: { id: intentId, status: current.status },
        data: {
          status: to,
          ...(txHash !== undefined ? { txHash } : {}),
          ...setSource,
        },
      });
      if (guarded.count === 0) {
        throw ApiError.conflict(
          ApiErrorCode.OperationInFlight,
          `Payment intent ${intentId} status changed concurrently; expected ${from}`,
        );
      }

      await tx.paymentIntentTransition.create({
        data: {
          intentId,
          fromStatus: current.status,
          toStatus: to,
          txHash: txHash ?? null,
          actor: opts.actor,
          reason: opts.reason ?? null,
        },
      });

      return tx.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    });

    this.logger.log(
      `Payment intent ${intentId} transition ${from} → ${to}` +
        (txHash ? ` (tx=${txHash})` : '') +
        ` actor=${opts.actor}`,
    );
    await this.emit(opts.consumerUsername, this.statusEvent(to), updated);

    if (to === 'SUCCEEDED') {
      void this.upsertCustomerFromPayment(updated, opts.payer).catch((err) =>
        this.logger.warn(
          `Could not auto-create customer for intent ${intentId}: ${String(err)}`,
        ),
      );
    }

    return updated;
  }

  /** Consultable audit trail for a single intent (scoped to the consumer). */
  async listTransitions(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<PaymentIntentTransition[]> {
    await this.assertOwned(consumer, id);
    return this.prisma.paymentIntentTransition.findMany({
      where: { intentId: id },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  async remove(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    await this.assertOwned(consumer, id);
    // A paid (SUCCEEDED) intent is an immutable record of a settled payment — it
    // must not be deletable.
    const existing = await this.prisma.paymentIntent.findUnique({
      where: { id },
      select: { status: true },
    });
    if (existing?.status === 'SUCCEEDED') {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        'A paid payment intent cannot be deleted.',
      );
    }
    const deleted = await this.prisma.paymentIntent.delete({ where: { id } });
    this.logger.log(
      `Deleted payment intent ${id} (consumer=${consumer.username})`,
    );
    await this.emit(consumer.username, 'PAYMENT_INTENT_DELETED', deleted);
    return { id, deleted: true };
  }

  // ── VALIDATE (manual reconciliation) ─────────────────────────────────────────
  /**
   * Validates a submitted transaction against the intent (memo, age,
   * destination, asset, amount and success). On a confirmed match the intent is
   * finalized to SUCCEEDED and a webhook event fires; if it is this intent's
   * payment but failed on-chain it is marked FAILED. Every other mismatch (wrong
   * amount/memo/hash, an older or unrelated transaction) leaves the status
   * untouched so a correct tx can still be submitted later.
   */
  async validate(
    consumer: GatewayConsumer,
    id: string,
    txHash: string,
  ): Promise<ValidationOutcome> {
    const intent = await this.prisma.paymentIntent.findFirst({
      where: { id, consumer: { apisixUsername: consumer.username } },
    });
    if (!intent) {
      throw ApiError.notFound(`Payment intent ${id} not found`);
    }

    // Already settled — return current state without re-querying the network.
    if (intent.status === 'SUCCEEDED') {
      return {
        valid: true,
        status: 'SUCCEEDED',
        paymentIntent: await this.withQr(intent),
      };
    }

    const result = await this.verifier.verifyByHash(intent, txHash);

    if (result.valid) {
      const updated = await this.markSucceeded(
        intent.id,
        consumer.username,
        result.txHash ?? txHash,
        result.payer,
      );
      return {
        valid: true,
        status: 'SUCCEEDED',
        paymentIntent: await this.withQr(updated),
      };
    }

    // This intent's own payment failed on-chain → settle as FAILED. The verifier
    // only says so once memo, age and a payment operation all match: FAILED is
    // terminal, and the hash of any unrelated failed transaction used to reach
    // it. Everything else is a mismatch and changes nothing.
    if (result.failedOnChain) {
      const updated = await this.markFailed(
        intent.id,
        consumer.username,
        txHash,
      );
      return {
        valid: false,
        status: 'FAILED',
        reason: result.reason,
        paymentIntent: await this.withQr(updated),
      };
    }

    return { valid: false, status: intent.status, reason: result.reason };
  }

  /** Finalizes an intent as SUCCEEDED and emits the event. Reused by the observer. */
  async markSucceeded(
    intentId: string,
    consumerUsername: string,
    txHash: string,
    payer?: string,
    actor: PaymentIntentTransitionActor = 'validate',
  ): Promise<PaymentIntent> {
    return this.transition(intentId, 'SUCCEEDED', {
      consumerUsername,
      actor,
      reason: 'on-chain payment confirmed',
      txHash,
      payer,
    });
  }

  /**
   * Auto-create a Customer from a settled payment's payer (the on-chain source,
   * falling back to the intent's source for TX intents). Idempotent per
   * (consumer, account) so repeat payers don't duplicate.
   */
  private async upsertCustomerFromPayment(
    intent: PaymentIntent,
    payer?: string,
  ): Promise<void> {
    const account = payer ?? intent.source ?? null;
    if (!account) return;
    const existing = await this.prisma.customer.findFirst({
      where: { consumerId: intent.consumerId, account },
      select: { id: true },
    });
    if (existing) return;
    await this.prisma.customer.create({
      data: {
        consumerId: intent.consumerId,
        name: `${account.slice(0, 6)}…${account.slice(-4)}`,
        account,
        reference: 'auto',
      },
    });
    this.logger.log(
      `Auto-created customer ${account} for consumer ${intent.consumerId}`,
    );
  }

  /** Finalizes an intent as FAILED and emits the event. */
  async markFailed(
    intentId: string,
    consumerUsername: string,
    txHash?: string,
    actor: PaymentIntentTransitionActor = 'validate',
  ): Promise<PaymentIntent> {
    return this.transition(intentId, 'FAILED', {
      consumerUsername,
      actor,
      reason: 'on-chain payment failed or rejected',
      txHash,
    });
  }

  /** Finalizes an unpaid, past-lifetime intent as EXPIRED. Reused by the observer. */
  async markExpired(
    intentId: string,
    consumerUsername: string,
    actor: PaymentIntentTransitionActor = 'observer',
  ): Promise<PaymentIntent> {
    return this.transition(intentId, 'EXPIRED', {
      consumerUsername,
      actor,
      reason: 'intent lifetime elapsed before settlement',
    });
  }

  /** Throws 404 unless the intent exists and belongs to the consumer. */
  private async assertOwned(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<void> {
    const owned = await this.prisma.paymentIntent.findFirst({
      where: { id, consumer: { apisixUsername: consumer.username } },
      select: { id: true },
    });
    if (!owned) {
      throw ApiError.notFound(`Payment intent ${id} not found`);
    }
  }

  private async loadAccount(network: StellarNetwork, source: string) {
    try {
      return await this.stellar.server(network).loadAccount(source);
    } catch (error: unknown) {
      // A 404 from Horizon means the account doesn't exist / isn't funded.
      const status = (error as { response?: { status?: number } })?.response
        ?.status;
      if (status === 404) {
        throw ApiError.badRequest(
          ApiErrorCode.ValidationFailed,
          `Source account ${source} not found or not funded on the ${network} network`,
        );
      }
      this.logger.error('Failed to load source account from Horizon', error);
      throw ApiError.unavailable(
        ApiErrorCode.ProviderUnavailable,
        'Could not reach the Stellar network',
      );
    }
  }
}
