/**
 * Resend's send endpoint. HTTPS on 443 rather than SMTP, because the hosts this
 * runs on routinely block outbound 25/465/587 (OVH does) and an email door that
 * only works on some providers is one nobody can rely on.
 */
export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Budget for one send. The person is watching a "sending code" spinner, and the
 * caller turns a failure into a refused sign-in they can retry — a slow answer
 * is worse than a fast no.
 */
export const DEFAULT_MAIL_TIMEOUT_MS = 15_000;

/** SMTP submission port with STARTTLS — the one providers expect by default. */
export const DEFAULT_MAIL_SMTP_PORT = 587;

/**
 * Minutes quoted in the copy when the expiry will not parse. Only the wording
 * depends on it: the row that checks the code has its own expiry.
 */
export const FALLBACK_CODE_MINUTES = 15;
