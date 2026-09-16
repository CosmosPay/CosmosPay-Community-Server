/** Tuning knobs and policy lists for the KYC flows. */

/** Local placeholder id for a receiver that doesn't exist at BlindPay yet. */
export const LOCAL_RECEIVER_PREFIX = 'local_';

/** How long before the same receiver may be sent another ToS email. */
export const TOS_EMAIL_COOLDOWN_MS = 24 * 60 * 60 * 1000; // once per day

/**
 * Receiver fields a tenant key may still change once the receiver exists at
 * BlindPay: its own reference and a display image — nothing that describes the
 * person or business under KYC.
 *
 * Before that point an edit re-enters `pending_review`. After it, a PUT rewrites
 * the identity at the provider with no review at all, so every other field —
 * names, tax id, date of birth, address, documents, owners, contact details —
 * needs an elevated caller. An allowlist, so a field added to
 * `CreateReceiverDto` later is reviewer-only until someone lists it here.
 */
export const RECEIVER_TENANT_EDITABLE_FIELDS: readonly string[] = [
  'external_id',
  'image_url',
];

// --- Document upload -------------------------------------------------------
//
// Multer buffers every part of an upload in memory, and its defaults bound
// almost none of them: unlimited files, unlimited text fields at 1 MB each,
// unlimited parts. Each count below is what `POST /v1/kyc/upload` actually
// needs, so the most a `kyc:write` key can make this process hold is one
// document plus a few kilobytes.

/** 10 MB — comfortably above a passport scan, far below a heap exhaustion. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** One document per request: the route reads a single `file` part. */
export const MAX_UPLOAD_FILES = 1;

/**
 * Text fields per request. The route reads exactly one, `bucket`; the other
 * slots are slack, so a client that sends an extra field alongside (a filename,
 * say) is not refused, and at {@link MAX_UPLOAD_FIELD_BYTES} each they cost
 * almost nothing. What this replaces is no limit at all, which let a key stream
 * fields into the heap without ever sending a file.
 */
export const MAX_UPLOAD_FIELDS = 4;

/**
 * Bytes per text field. The longest value the route accepts, `limit_increase`,
 * is 14 bytes; multer's default is 1 MB — per field, times however many fields
 * the client cared to send.
 */
export const MAX_UPLOAD_FIELD_BYTES = 1024;

/**
 * Parts of any kind, as a backstop behind the two counts above. Busboy fires this
 * limit on *reaching* the number rather than on exceeding it, so it sits one
 * above the largest legitimate form; an exact total would refuse that form's
 * last part.
 */
export const MAX_UPLOAD_PARTS = MAX_UPLOAD_FILES + MAX_UPLOAD_FIELDS + 1;

/** Leading bytes that identify a format: `bytes`, found at `offset`. */
export interface SignaturePart {
  offset: number;
  bytes: readonly number[];
}

/** One way a format announces itself — it matches when every part does. */
export type FileSignature = readonly SignaturePart[];

const ascii = (text: string): number[] => [...Buffer.from(text, 'latin1')];

/**
 * HEIC and HEIF are one container (ISO BMFF): `ftyp` at byte 4, then a brand at
 * byte 8. Encoders do not keep the brands apart by MIME type — `mif1` is written
 * for both — so either type accepts any of them rather than pretend the split is
 * clean.
 */
const HEIF_SIGNATURES: readonly FileSignature[] = [
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
].map((brand) => [
  { offset: 4, bytes: ascii('ftyp') },
  { offset: 8, bytes: ascii(brand) },
]);

/**
 * The types a KYC document may be, each with the bytes that prove it.
 *
 * Identity documents are images or PDFs; nothing else has a reason to be here.
 * The declared `Content-Type` is only the client's word for that, and the bytes
 * are relayed to the provider's storage under a document filename, so the
 * content is checked against the declaration as well (`KycMetaService`). Type
 * and signature live in one map so that a type cannot be allowed without one.
 *
 * PDF is anchored at offset 0 even though readers tolerate leading bytes: what a
 * scanner or an export writes starts with `%PDF-`, and that tolerance is exactly
 * the room a polyglot file needs.
 */
export const UPLOAD_SIGNATURES: Readonly<
  Record<string, readonly FileSignature[]>
> = {
  'image/jpeg': [[{ offset: 0, bytes: [0xff, 0xd8, 0xff] }]],
  'image/png': [
    [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  ],
  'image/webp': [
    [
      { offset: 0, bytes: ascii('RIFF') },
      { offset: 8, bytes: ascii('WEBP') },
    ],
  ],
  'image/heic': HEIF_SIGNATURES,
  'image/heif': HEIF_SIGNATURES,
  'application/pdf': [[{ offset: 0, bytes: ascii('%PDF-') }]],
};

/** The declared types the upload filter lets through: those with a signature. */
export const ALLOWED_UPLOAD_TYPES = new Set(Object.keys(UPLOAD_SIGNATURES));

// --- Rate limits -------------------------------------------------------------
//
// Both routes below reach BlindPay, so both also carry
// `BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT` — the per-address budgets here separate
// ordinary callers, the ceiling there separates tenants.

/**
 * Budget for `POST /v1/kyc/upload`, per consumer + client address.
 *
 * What is defended: the route accepts a file, sniffs it, and hands it to
 * BlindPay's storage, which keeps it. An error response does not delete what was
 * already stored nor refund the provider call, so this is the shape `@RateLimit`
 * exists for. Nothing here is anonymous — an upload needs a real key — so the
 * address is about one integrator's runaway loop, not about telling strangers
 * apart.
 *
 * Why twenty in ten minutes. A receiver submits an identity document, sometimes
 * a second page, sometimes a proof of address, and retries a failed upload: five
 * to eight files for a thorough case. Twenty covers two or three people being
 * onboarded at once from one office address while holding a loop to two a
 * minute.
 */
export const KYC_UPLOAD_RATE_LIMIT = {
  name: 'kyc:upload',
  limit: 20,
  windowMs: 10 * 60 * 1000,
};

/**
 * Budget for `POST /v1/kyc/terms-of-service`, per consumer + client address.
 *
 * Each call creates a terms-of-service record at BlindPay and returns a hosted
 * URL; the record stays whatever this service answers afterwards. Ten in ten
 * minutes is several onboarding attempts — the URL is handed to a person, who
 * takes minutes, not milliseconds — and leaves no room for a loop that fills the
 * provider with orphan records.
 */
export const KYC_TOS_RATE_LIMIT = {
  name: 'kyc:tos',
  limit: 10,
  windowMs: 10 * 60 * 1000,
};
