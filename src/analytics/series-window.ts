import {
  SERIES_PERIODS,
  type SeriesPeriod,
} from '@/analytics/analytics.constants';

/**
 * The buckets of `GET /v1/summary/series`, in UTC and on the same boundaries as Postgres'
 * `date_trunc` (weeks start on Monday), so every row the query returns lands on a bucket here.
 * Pure, so the boundaries are tested without a database.
 */

/** The start of the bucket that holds `at`. */
export function bucketStart(period: SeriesPeriod, at: Date): Date {
  const d = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
  if (period === 'week')
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (period === 'month') d.setUTCDate(1);
  if (period === 'year') d.setUTCMonth(0, 1);
  return d;
}

/** `start` moved by `n` buckets (negative goes back). */
export function shiftBuckets(
  period: SeriesPeriod,
  start: Date,
  n: number,
): Date {
  const d = new Date(start);
  if (period === 'day') d.setUTCDate(d.getUTCDate() + n);
  if (period === 'week') d.setUTCDate(d.getUTCDate() + 7 * n);
  if (period === 'month') d.setUTCMonth(d.getUTCMonth() + n);
  if (period === 'year') d.setUTCFullYear(d.getUTCFullYear() + n);
  return d;
}

/**
 * The window the chart shows (its buckets, oldest first, the current one last) and the window
 * of the same length just before it, which the growth figures compare against.
 */
export function seriesWindow(period: SeriesPeriod, now: Date) {
  const count = SERIES_PERIODS[period];
  const first = shiftBuckets(period, bucketStart(period, now), -(count - 1));
  const buckets = Array.from({ length: count }, (_, i) =>
    shiftBuckets(period, first, i),
  );
  return {
    buckets,
    since: first,
    previousSince: shiftBuckets(period, first, -count),
  };
}

/** The `start` a bucket is reported under: its first day, `YYYY-MM-DD`. */
export function bucketKey(at: Date): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * One entry per bucket of the window, oldest first: `fill` of the row Postgres grouped into it,
 * or `empty()` when it grouped none, so a quiet bucket is a zero rather than a gap. A row that
 * lands on no bucket is dropped; it cannot happen while both sides truncate alike.
 */
export function fillBuckets<R extends { bucket: Date }, T extends object>(
  buckets: readonly Date[],
  rows: readonly R[],
  empty: () => T,
  fill: (row: R) => T,
): ({ start: string } & T)[] {
  const byKey = new Map(rows.map((row) => [bucketKey(row.bucket), row]));
  return buckets.map((at) => {
    const start = bucketKey(at);
    const row = byKey.get(start);
    return { start, ...(row ? fill(row) : empty()) };
  });
}
