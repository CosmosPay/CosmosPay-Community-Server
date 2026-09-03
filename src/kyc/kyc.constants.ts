/** Tuning knobs and policy lists for the KYC flows. */

/** Local placeholder id for a receiver that doesn't exist at BlindPay yet. */
export const LOCAL_RECEIVER_PREFIX = 'local_';

/** How long before the same receiver may be sent another ToS email. */
export const TOS_EMAIL_COOLDOWN_MS = 24 * 60 * 60 * 1000; // once per day

/** 10 MB — comfortably above a passport scan, far below a heap exhaustion. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Identity documents are images or PDFs; nothing else has a reason to be here. */
export const ALLOWED_UPLOAD_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);
