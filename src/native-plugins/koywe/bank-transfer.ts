import {
  BANK_TRANSFER_LIFETIME_MS,
  BANK_TRANSFER_REASON_MAX,
  BANK_TRANSFER_RETRY_BASE_MS,
  BANK_TRANSFER_RETRY_MAX_MS,
} from '@/native-plugins/koywe/koywe.constants';

/**
 * A payer's bank transfer for a payment request: the pure rules over a row,
 * with no Nest and no I/O.
 */

/** What a transfer reads as. `expired` is derived, never stored. */
export const BANK_TRANSFER_STATUSES = [
  'awaiting_deposit',
  'converting',
  'completed',
  'failed',
  'expired',
] as const;
export type BankTransferStatus = (typeof BANK_TRANSFER_STATUSES)[number];

/** What the `status` column holds. */
export type StoredBankTransferStatus = Exclude<BankTransferStatus, 'expired'>;

const STORED: readonly string[] = BANK_TRANSFER_STATUSES.filter(
  (status) => status !== 'expired',
);

/**
 * What a transfer reads as at `now`: its stored status, except one still
 * awaiting its deposit past `expiresAt`, which reads as expired (it may still
 * match a late deposit: the money must reach the seller). A value the column
 * should never hold is a corrupt row: an error, not a guess.
 */
export function effectiveTransferStatus(
  row: { id: string; status: string; expiresAt: Date },
  now: Date,
): BankTransferStatus {
  if (!STORED.includes(row.status)) {
    throw new Error(
      `Bank transfer ${row.id} has unknown status "${row.status}"`,
    );
  }
  return row.status === 'awaiting_deposit' &&
    row.expiresAt.getTime() <= now.getTime()
    ? 'expired'
    : (row.status as StoredBankTransferStatus);
}

/** When a transfer opened at `now` stops being offered: an hour, never past its request. */
export function transferExpiry(now: Date, requestExpiresAt: Date): Date {
  return new Date(
    Math.min(
      now.getTime() + BANK_TRANSFER_LIFETIME_MS,
      requestExpiresAt.getTime(),
    ),
  );
}

/** A non-negative decimal string. */
const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** Local money as a request may ask it: digits with at most two decimals. */
export const LOCAL_MONEY_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Compares two non-negative decimal strings exactly (no float): -1, 0 or 1.
 * Throws on anything else: amounts reach here already read.
 */
export function compareDecimals(a: string, b: string): -1 | 0 | 1 {
  if (!DECIMAL_RE.test(a) || !DECIMAL_RE.test(b)) {
    throw new Error(`Not decimal amounts: "${a}", "${b}"`);
  }
  const [aInt, aFrac = ''] = a.split('.');
  const [bInt, bFrac = ''] = b.split('.');
  const scale = Math.max(aFrac.length, bFrac.length);
  const x = BigInt(aInt + aFrac.padEnd(scale, '0'));
  const y = BigInt(bInt + bFrac.padEnd(scale, '0'));
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * An amount the provider reported (a JSON number or a string) as a plain
 * non-negative decimal string, never in exponent form; null for anything else.
 */
export function decimalString(raw: unknown): string | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return raw.toLocaleString('en-US', {
      useGrouping: false,
      maximumFractionDigits: 18,
    });
  }
  if (typeof raw === 'string') {
    const text = raw.trim();
    return DECIMAL_RE.test(text) ? text : null;
  }
  return null;
}

/** How long to wait before attempt `attempts + 1` of a conversion: a minute, doubling, at most an hour. */
export function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts, 16));
  return Math.min(
    BANK_TRANSFER_RETRY_BASE_MS * 2 ** exponent,
    BANK_TRANSFER_RETRY_MAX_MS,
  );
}

/** A reason kept on a row or logged: one line, bounded. */
export function shortReason(text: string, max = BANK_TRANSFER_REASON_MAX) {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Local money (at most two decimals) in cents. */
function toCents(amount: string): bigint {
  if (!LOCAL_MONEY_RE.test(amount)) {
    throw new Error(`Not an amount of local money: "${amount}"`);
  }
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

/** Cents back to local money: whole when it is, else two decimals. */
function fromCents(cents: bigint): string {
  const whole = cents / 100n;
  const rest = cents % 100n;
  return rest === 0n
    ? whole.toString()
    : `${whole}.${rest.toString().padStart(2, '0')}`;
}

/**
 * What a new transfer tells the payer to send, so that every open transfer of
 * one depositor at one merchant asks a different amount and a deposit names
 * exactly one of them: the request's own amount when no open transfer of the
 * same depositor asks it, else that amount plus the first free 0.01 to 0.99.
 * Null when all 99 are taken.
 */
export function distinctAmount(
  amount: string,
  inUse: readonly string[],
): string | null {
  const base = toCents(amount);
  const taken = new Set(
    inUse.filter((used) => LOCAL_MONEY_RE.test(used)).map(toCents),
  );
  for (let suffix = 0n; suffix < 100n; suffix += 1n) {
    if (!taken.has(base + suffix)) return fromCents(base + suffix);
  }
  return null;
}

/**
 * Which open transfer a deposit pays, among the depositor's at the merchant
 * the deposit landed in (oldest first), or why none:
 *
 * - one asking exactly the deposited amount (two would be a tie: none);
 * - else, only when the depositor has a single open transfer there and the
 *   deposit covers it, that one (an overpayment: the whole deposit is
 *   converted for the seller);
 * - else none. A larger deposit with several candidates could belong to any
 *   of them, and a smaller one pays none: both wait for ops.
 */
export function matchDeposit<T extends { instructedAmount: string }>(
  candidates: readonly T[],
  deposited: string,
): { match: T | null; reason: string | null } {
  if (candidates.length === 0) {
    return { match: null, reason: 'no open transfer for this depositor' };
  }
  const exact = candidates.filter(
    (candidate) => compareDecimals(candidate.instructedAmount, deposited) === 0,
  );
  if (exact.length === 1) return { match: exact[0], reason: null };
  if (exact.length > 1) {
    return {
      match: null,
      reason: `${exact.length} open transfers of this depositor ask the same amount`,
    };
  }
  if (candidates.length > 1) {
    return {
      match: null,
      reason: `no open transfer asks exactly this amount, and ${candidates.length} could take it`,
    };
  }
  return compareDecimals(candidates[0].instructedAmount, deposited) < 0
    ? { match: candidates[0], reason: null }
    : { match: null, reason: 'short of the open transfer for this depositor' };
}
