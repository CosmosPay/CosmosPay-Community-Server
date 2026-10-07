import { HttpException } from '@nestjs/common';
import type { Prisma } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  BLINDPAY_AMBIGUOUS_CLIENT_STATUSES,
  EPOCH_SECONDS_CEILING,
  MIRROR_FRESHNESS_MS,
} from '@/native-plugins/blindpay/blindpay.constants';

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

/**
 * When a BlindPay quote stops being usable, from its `expires_at` (seconds or
 * milliseconds since the epoch — see {@link EPOCH_SECONDS_CEILING}). Null when the
 * provider sent nothing readable: such a quote is not refused as expired, and
 * BlindPay still rejects it upstream if it has lapsed.
 */
export function quoteExpiresAt(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value < EPOCH_SECONDS_CEILING ? value * 1000 : value);
}

/**
 * True when a failed provider call certainly created nothing: BlindPay refused
 * it with a 4xx that is not {@link BLINDPAY_AMBIGUOUS_CLIENT_STATUSES}, or the
 * instance is not configured and the request never left. A timeout, a 5xx or a
 * transport failure is NOT a refusal — the provider may have acted before the
 * answer was lost, so a row opened for the call has to stay.
 */
export function isProviderRefusal(err: unknown): boolean {
  if (err instanceof ApiError && err.code === ApiErrorCode.Misconfigured) {
    return true;
  }
  if (!(err instanceof HttpException)) return false;
  const status = err.getStatus();
  return (
    status >= 400 &&
    status < 500 &&
    !BLINDPAY_AMBIGUOUS_CLIENT_STATUSES.includes(status)
  );
}
