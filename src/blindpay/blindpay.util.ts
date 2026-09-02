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

/**
 * How long a mirrored BlindPay row may be served from our own database before a
 * single-resource read refreshes it upstream.
 *
 * Webhooks are the primary path for status changes, so the refresh is a safety
 * net for a missed delivery rather than the source of truth. Refreshing on
 * *every* GET pinned our p99 to BlindPay's (15s timeout, no retry) and turned
 * each read into a write; a short window keeps reads local while bounding how
 * stale an un-webhooked row can get.
 */
export const MIRROR_FRESHNESS_MS = 60_000;

/**
 * True when a mirrored row can answer a read without contacting BlindPay. A row
 * that never received a provider status has nothing to serve, so it always
 * refreshes — that keeps the pre-webhook behaviour for a record we only know
 * locally.
 */
export function isMirrorFresh(row: {
  status: string | null;
  updatedAt: Date;
}): boolean {
  if (row.status === null) return false;
  return Date.now() - row.updatedAt.getTime() < MIRROR_FRESHNESS_MS;
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
