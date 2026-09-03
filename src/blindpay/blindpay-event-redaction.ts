import type { WebhookEventType } from '@generated/prisma/client';
import type { BlindpayObject } from '@/blindpay/blindpay-sync.service';

/**
 * The provider fields a re-emitted BlindPay event may carry to an integrator.
 *
 * Inbound BlindPay objects were previously forwarded whole as the outbound
 * event body. For `receiver.*` that object is the complete KYC dossier —
 * `tax_id`, `date_of_birth`, `id_doc_front_file`, `selfie_file`, address, phone,
 * and the same again for every beneficial owner in `owners[]`; for `payin.*` it
 * carries bank credentials. That is the same material `RECEIVER_PUBLIC_SELECT`
 * keeps out of every `kyc:read` response and `omit: { raw: true }` keeps out of
 * the admin lists.
 *
 * Closing the read-back path was not enough. Registering an endpoint needs only
 * `webhooks:write`, `eventTypes` accepts any event (and omitting it subscribes
 * to all), and fan-out filters on consumer and event type — never on scope. So
 * a key with no KYC scope at all could register `https://attacker.example/` and
 * have every receiver's dossier delivered to it, signed. Asking for the data to
 * be pushed bypassed the control that stopped it being read.
 *
 * The rule this establishes: **a webhook body carries identity and state, not
 * personal data.** An integrator learns *that* a receiver reached `approved`
 * and fetches the details from the API with a key that holds `kyc:read`. This
 * is the conventional thin-webhook shape and it makes the delivery log, which
 * is retained, safe by construction rather than by retention policy.
 */
const ALLOWED_FIELDS: Record<string, readonly string[]> = {
  // Identity and KYC state only. Never the dossier.
  receiver: [
    'id',
    'external_id',
    'type',
    'kyc_type',
    'kyc_status',
    'country',
    'created_at',
    'updated_at',
  ],
  // Amounts and rails. Never `blindpay_bank_details`, `clabe`, `cbu`,
  // `pix_code`, `pse_tax_id` or `pse_full_name` — the payer's funding
  // instructions are fetched from GET /v1/onramp/payins/:id under `onramp:read`.
  payin: [
    'id',
    'external_id',
    'status',
    'token',
    'network',
    'payment_method',
    'currency',
    'sender_amount',
    'receiver_amount',
    'payin_quote_id',
    'quote_id',
    'receiver_id',
    'created_at',
    'updated_at',
  ],
  payout: [
    'id',
    'external_id',
    'status',
    'token',
    'network',
    'rail',
    'payment_method',
    'sender_amount',
    'receiver_amount',
    'quote_id',
    'receiver_id',
    'bank_account_id',
    'created_at',
    'updated_at',
  ],
};

/** `RECEIVER_UPDATED` → `receiver`, `PAYIN_*` → `payin`, `PAYOUT_*` → `payout`. */
function resourceOf(event: WebhookEventType): string | null {
  if (event === 'RECEIVER_UPDATED') return 'receiver';
  if (event.startsWith('PAYIN_')) return 'payin';
  if (event.startsWith('PAYOUT_')) return 'payout';
  return null;
}

/**
 * Projects a provider object onto the fields that may leave the platform.
 *
 * An allowlist, never a denylist: BlindPay can add a field to its payload at any
 * time without telling us, and a denylist would forward it by default. An event
 * type with no entry here is not a BlindPay re-emission and passes through — the
 * Stellar-native events build their own bodies from our own rows.
 */
export function redactProviderEvent(
  event: WebhookEventType,
  data: BlindpayObject,
): BlindpayObject {
  const resource = resourceOf(event);
  if (!resource) return data;

  const allowed = ALLOWED_FIELDS[resource];
  const out: BlindpayObject = {};
  for (const key of allowed) {
    if (data[key] !== undefined && data[key] !== null) {
      out[key] = data[key];
    }
  }
  return out;
}
