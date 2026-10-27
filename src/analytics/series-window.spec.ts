import {
  bucketKey,
  bucketStart,
  fillBuckets,
  seriesWindow,
  shiftBuckets,
} from '@/analytics/series-window';

const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('series window', () => {
  // A Thursday afternoon, UTC.
  const now = new Date('2026-10-22T15:30:00Z');

  it('truncates like Postgres date_trunc: days, Monday weeks, months, years', () => {
    expect(iso(bucketStart('day', now))).toBe('2026-10-22');
    expect(iso(bucketStart('week', now))).toBe('2026-10-19');
    expect(iso(bucketStart('week', new Date('2026-10-19T00:00:00Z')))).toBe(
      '2026-10-19',
    );
    expect(iso(bucketStart('week', new Date('2026-10-25T23:59:59Z')))).toBe(
      '2026-10-19',
    );
    expect(iso(bucketStart('month', now))).toBe('2026-10-01');
    expect(iso(bucketStart('year', now))).toBe('2026-01-01');
  });

  it('moves by whole buckets, months included', () => {
    expect(
      iso(shiftBuckets('month', new Date('2026-03-01T00:00:00Z'), -2)),
    ).toBe('2026-01-01');
    expect(iso(shiftBuckets('week', new Date('2026-10-19T00:00:00Z'), 1))).toBe(
      '2026-10-26',
    );
  });

  it('shows the configured number of buckets, the current one last, and the window before', () => {
    const month = seriesWindow('month', now);
    expect(month.buckets).toHaveLength(12);
    expect(iso(month.buckets[0])).toBe('2025-11-01');
    expect(iso(month.buckets[11])).toBe('2026-10-01');
    expect(iso(month.since)).toBe('2025-11-01');
    expect(iso(month.previousSince)).toBe('2024-11-01');

    const day = seriesWindow('day', now);
    expect(day.buckets).toHaveLength(30);
    expect(iso(day.buckets[29])).toBe('2026-10-22');
    expect(iso(day.previousSince)).toBe('2026-08-24');

    expect(seriesWindow('year', now).buckets.map(iso)).toEqual([
      '2022-01-01',
      '2023-01-01',
      '2024-01-01',
      '2025-01-01',
      '2026-01-01',
    ]);
  });
  it('reports a bucket by its first day, whatever time of day the row carries', () => {
    expect(bucketKey(new Date('2026-10-19T00:00:00Z'))).toBe('2026-10-19');
    expect(bucketKey(new Date('2026-10-19T23:59:59.999Z'))).toBe('2026-10-19');
  });

  it('fills the buckets that have rows and seeds a fresh zero in every other one', () => {
    const { buckets } = seriesWindow('week', now);
    const rows = [
      { bucket: new Date('2026-10-19T00:00:00Z'), count: 3n },
      { bucket: new Date('2026-08-03T00:00:00Z'), count: 1n },
      // Outside the window: dropped, never appended.
      { bucket: new Date('2026-07-27T00:00:00Z'), count: 9n },
    ];

    const filled = fillBuckets(
      buckets,
      rows,
      () => ({ count: 0 }),
      (row) => ({ count: Number(row.count) }),
    );

    expect(filled).toHaveLength(12);
    expect(filled[0]).toEqual({ start: '2026-08-03', count: 1 });
    expect(filled[11]).toEqual({ start: '2026-10-19', count: 3 });
    expect(filled.slice(1, 11).every((b) => b.count === 0)).toBe(true);
    // Each zero is its own object, so a caller mutating one cannot change another.
    expect(filled[1]).not.toBe(filled[2]);
  });
});
