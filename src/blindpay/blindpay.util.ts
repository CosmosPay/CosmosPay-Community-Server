import type { Prisma } from '../../generated/prisma/client';

/**
 * Casts a provider payload (`unknown`) to Prisma's JSON input type so it can be
 * stored in a `Json` column. The assertion lives here, in one place, rather than
 * at every `raw`/`instructions` assignment.
 */
export function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/**
 * Safe coercion of provider (BlindPay) values, which arrive as `unknown`. Only
 * scalars become strings; objects/arrays/null become null (we never want
 * `[object Object]` landing in a mirror column). Used by the sync mappers and
 * the feature services.
 */
export function asNullableString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

/** Like {@link asNullableString} but returns '' instead of null (for ids). */
export function asString(value: unknown): string {
  return asNullableString(value) ?? '';
}

/** Coerce a provider scalar to a finite number, or 0 when it isn't numeric. */
export function asNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
