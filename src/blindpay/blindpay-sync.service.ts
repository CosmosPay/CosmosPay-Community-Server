import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { WEBHOOK_EVENT, WebhookEventPayload } from '../webhooks/webhook-events';
import { asNullableString, asString, toJson } from './blindpay.util';
import type {
  BlindpayReceiver,
  Payin,
  Payout,
  WebhookEventType,
} from '../../generated/prisma/client';

/** Loosely-typed BlindPay resource object (snake_case, provider-defined). */
export type BlindpayObject = Record<string, unknown>;

/**
 * Maps a BlindPay webhook event name to the internal event we re-emit to
 * integrators, or null when the event has no integrator-facing counterpart.
 */
const EVENT_MAP: Record<string, WebhookEventType> = {
  'receiver.new': 'RECEIVER_UPDATED',
  'receiver.update': 'RECEIVER_UPDATED',
  'payin.new': 'PAYIN_CREATED',
  'payin.update': 'PAYIN_UPDATED',
  'payin.complete': 'PAYIN_COMPLETED',
  'payout.new': 'PAYOUT_CREATED',
  'payout.update': 'PAYOUT_UPDATED',
  'payout.complete': 'PAYOUT_COMPLETED',
};

/**
 * The bridge between BlindPay's resources and our local mirror.
 *
 * Feature services call the `mirror*` methods after a successful create so we
 * persist a consumer-scoped copy. The inbound webhook controller calls
 * {@link handleWebhook} when BlindPay reports a state change: we update the
 * mirror and re-emit a Cosmos Pay webhook event to the owning integrator so they
 * learn about it through the same channel as payment-intent events.
 */
@Injectable()
export class BlindpaySyncService {
  private readonly logger = new Logger(BlindpaySyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  // --- create-time mirroring (called by feature services) ------------------

  mirrorReceiver(
    consumerId: string,
    obj: BlindpayObject,
  ): Promise<BlindpayReceiver> {
    const data = {
      type: asNullableString(obj.type) ?? 'individual',
      kycType: asNullableString(obj.kyc_type),
      kycStatus: asNullableString(obj.kyc_status),
      email: asNullableString(obj.email),
      name: receiverName(obj),
      country: asNullableString(obj.country),
      externalId: asNullableString(obj.external_id),
      raw: toJson(obj),
    };
    return this.prisma.blindpayReceiver.upsert({
      where: {
        consumerId_blindpayId: { consumerId, blindpayId: asString(obj.id) },
      },
      create: { consumerId, blindpayId: asString(obj.id), ...data },
      update: data,
    });
  }

  mirrorPayin(
    consumerId: string,
    receiverId: string | null,
    obj: BlindpayObject,
  ): Promise<Payin> {
    const data = {
      receiverId,
      quoteId: asNullableString(obj.payin_quote_id ?? obj.quote_id),
      status: asNullableString(obj.status),
      token: asNullableString(obj.token),
      network: asNullableString(obj.network),
      paymentMethod: asNullableString(obj.payment_method),
      currency: asNullableString(obj.currency),
      senderAmount: asNullableString(obj.sender_amount),
      receiverAmount: asNullableString(obj.receiver_amount),
      instructions: toJson(pickInstructions(obj)),
      raw: toJson(obj),
    };
    return this.prisma.payin.upsert({
      where: {
        consumerId_blindpayId: { consumerId, blindpayId: asString(obj.id) },
      },
      create: { consumerId, blindpayId: asString(obj.id), ...data },
      update: data,
    });
  }

  mirrorPayout(
    consumerId: string,
    receiverId: string | null,
    obj: BlindpayObject,
  ): Promise<Payout> {
    const data = {
      receiverId,
      quoteId: asNullableString(obj.quote_id),
      status: asNullableString(obj.status),
      token: asNullableString(obj.token),
      network: asNullableString(obj.network),
      rail: asNullableString(obj.rail ?? obj.payment_method),
      bankAccountId: asNullableString(obj.bank_account_id),
      senderAmount: asNullableString(obj.sender_amount),
      receiverAmount: asNullableString(obj.receiver_amount),
      senderWalletAddress: asNullableString(obj.sender_wallet_address),
      raw: toJson(obj),
    };
    return this.prisma.payout.upsert({
      where: {
        consumerId_blindpayId: { consumerId, blindpayId: asString(obj.id) },
      },
      create: { consumerId, blindpayId: asString(obj.id), ...data },
      update: data,
    });
  }

  // --- inbound webhook handling --------------------------------------------

  /**
   * Applies a BlindPay webhook: updates the local mirror's status and re-emits a
   * Cosmos Pay event to the resource owner. Unknown event types and events for
   * resources we never mirrored are ignored (logged), never thrown — BlindPay
   * retries on non-2xx, and we don't want to loop on events we can't attribute.
   */
  async handleWebhook(type: string, data: BlindpayObject): Promise<void> {
    const mapped = EVENT_MAP[type];
    const blindpayId = data.id ? asString(data.id) : null;

    if (!mapped || !blindpayId) {
      this.logger.debug(`Ignoring BlindPay webhook '${type}' (no mapping/id)`);
      return;
    }

    const resource = type.split('.')[0];
    const owner =
      resource === 'payin'
        ? await this.applyPayin(blindpayId, data)
        : resource === 'payout'
          ? await this.applyPayout(blindpayId, data)
          : resource === 'receiver'
            ? await this.applyReceiver(blindpayId, data)
            : null;

    if (!owner) {
      this.logger.warn(
        `BlindPay webhook '${type}' for ${blindpayId} matched no local record`,
      );
      return;
    }

    this.events.emit(
      WEBHOOK_EVENT,
      new WebhookEventPayload(owner, mapped, data),
    );
  }

  /** Updates a payin's status; returns the owning consumer username or null. */
  private async applyPayin(
    blindpayId: string,
    obj: BlindpayObject,
  ): Promise<string | null> {
    const row = await this.prisma.payin.findFirst({
      where: { blindpayId },
      include: { consumer: true },
    });
    if (!row) return null;
    await this.prisma.payin.update({
      where: { id: row.id },
      data: {
        status: asNullableString(obj.status) ?? row.status,
        raw: toJson(obj),
      },
    });
    return row.consumer.apisixUsername;
  }

  private async applyPayout(
    blindpayId: string,
    obj: BlindpayObject,
  ): Promise<string | null> {
    const row = await this.prisma.payout.findFirst({
      where: { blindpayId },
      include: { consumer: true },
    });
    if (!row) return null;
    await this.prisma.payout.update({
      where: { id: row.id },
      data: {
        status: asNullableString(obj.status) ?? row.status,
        raw: toJson(obj),
      },
    });
    return row.consumer.apisixUsername;
  }

  private async applyReceiver(
    blindpayId: string,
    obj: BlindpayObject,
  ): Promise<string | null> {
    const row = await this.prisma.blindpayReceiver.findFirst({
      where: { blindpayId },
      include: { consumer: true },
    });
    if (!row) return null;
    await this.prisma.blindpayReceiver.update({
      where: { id: row.id },
      data: {
        kycStatus: asNullableString(obj.kyc_status) ?? row.kycStatus,
        raw: toJson(obj),
      },
    });
    return row.consumer.apisixUsername;
  }
}

/** Derives a display name from an individual or business receiver payload. */
function receiverName(obj: BlindpayObject): string | null {
  const legal = asNullableString(obj.legal_name);
  if (legal) return legal;
  const full = [obj.first_name, obj.last_name]
    .map(asString)
    .filter(Boolean)
    .join(' ')
    .trim();
  return full || asNullableString(obj.name);
}

/**
 * Extracts the payer-facing funding instructions from a payin payload. Different
 * rails surface different fields (US bank details + memo, PIX code, CLABE, CBU,
 * PSE link); we keep whichever are present.
 */
function pickInstructions(obj: BlindpayObject): Record<string, unknown> {
  const keys = [
    'memo_code',
    'blindpay_bank_details',
    'pix_code',
    'clabe',
    'cbu',
    'pse_payment_link',
    'pse_full_name',
    'pse_tax_id',
    'pse_document_type',
    'virtual_account',
  ];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      out[key] = obj[key];
    }
  }
  return out;
}
