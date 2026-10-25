/** Tuning knobs for the read-only analytics aggregates. */

/** One day in milliseconds — the bucket width for time-series rollups. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The periods the dashboard's chart groups payments by, and how many buckets of each it shows
 * (`GET /v1/summary/series`): 30 days, 12 weeks, 12 months, 5 years.
 */
export const SERIES_PERIODS = {
  day: 30,
  week: 12,
  month: 12,
  year: 5,
} as const;
export type SeriesPeriod = keyof typeof SERIES_PERIODS;
