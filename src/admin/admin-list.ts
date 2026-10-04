import {
  ADMIN_DEFAULT_PAGE_SIZE,
  ADMIN_MAX_PAGE_SIZE,
} from '@/admin/admin.constants';

/**
 * The list conventions every platform-admin read shares — the core's and the
 * ones native plugins add under `/v1/admin` — so a page of receivers pages the
 * same way as a page of payment intents.
 *
 * The query string is validated before it gets here (`AdminPageQueryDto` and
 * its subclasses), so a malformed `take` is a 400 at the pipe. The clamps below
 * only cover a service called with no options at all.
 */

/** Shared list options: pagination + an optional owning-consumer filter (local id). */
export interface AdminListOpts {
  consumer?: string;
  take?: number;
  skip?: number;
}

/** Clamp a requested page size to a sane range. */
export function adminTake(n?: number): number {
  if (!n || n < 1) return ADMIN_DEFAULT_PAGE_SIZE;
  return Math.min(n, ADMIN_MAX_PAGE_SIZE);
}

export function adminSkip(n?: number): number {
  return !n || n < 0 ? 0 : n;
}

/** Attribution attached to every admin row: which consumer owns it. */
export const ADMIN_CONSUMER_INCLUDE = {
  consumer: { select: { apisixUsername: true, credentialId: true } },
};

/** Where-clause fragment scoping to a single consumer (org), or `{}` for all. */
export function consumerWhere(consumer?: string): { consumerId?: string } {
  return consumer ? { consumerId: consumer } : {};
}

/** `groupBy` rows folded into `{ value: count }`, a null group as `unknown`. */
export function tallyBy<K extends string>(
  rows: ReadonlyArray<
    Partial<Record<K, unknown>> & { _count: { _all: number } }
  >,
  key: K,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const value = row[key];
    const k = typeof value === 'string' ? value : 'unknown';
    out[k] = (out[k] ?? 0) + row._count._all;
  }
  return out;
}

export function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}
