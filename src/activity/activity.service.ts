import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { Prisma } from '@generated/prisma/client';
import { clientIp } from '@/common/client-ip';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { page } from '@/common/pagination';
import { toCount } from '@/common/money';
import { PrismaService } from '@/prisma/prisma.service';
import {
  ACTIVITY_MAX_BACKFILL_MS,
  ACTIVITY_MAX_CLOCK_SKEW_AHEAD_MS,
  ACTIVITY_MESSAGE_MAX,
  ACTIVITY_PROPS_MAX_BYTES,
  ACTIVITY_PROPS_OVERSIZED,
  ACTIVITY_SUMMARY_TOP_N,
} from '@/activity/activity.constants';
import {
  ACTIVITY_LEVELS,
  ActivityEventDto,
  IngestActivityDto,
} from '@/activity/dto/ingest-activity.dto';
import {
  ActivitySummaryQueryDto,
  QueryActivityDto,
} from '@/activity/dto/query-activity.dto';

/** One day in milliseconds — the bucket width for the daily rollup. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Longest user-agent kept. The tail of a long one carries no information. */
const USER_AGENT_MAX = 300;

/**
 * Severity as an ordinal, so `level=warn` can mean "warn and worse" rather than
 * "warn exactly". Filtering for problems and getting back only the rows
 * somebody labelled `error`, while the warnings that preceded them sat one rung
 * down, is the kind of filter that hides what it was opened to find.
 */
const LEVEL_RANK = new Map(ACTIVITY_LEVELS.map((l, i) => [l, i]));

/** Levels at or above `min`, for an `in` filter. */
function levelsAtLeast(min: string): string[] {
  const floor = LEVEL_RANK.get(min) ?? 0;
  return ACTIVITY_LEVELS.filter((l) => (LEVEL_RANK.get(l) ?? 0) >= floor);
}

/**
 * Client-reported activity: what the wallet and the dashboard did, including
 * everything that never became a request to this service.
 *
 * Two rules the rest of this file exists to keep:
 *
 *   - **Attribution comes from the gateway, never the body.** Every row is
 *     written under the consumer APISIX authenticated, so a client cannot file
 *     its events against somebody else's account no matter what it sends.
 *   - **Ingest never fails on the shape of a payload.** An over-long message is
 *     truncated and an over-sized `props` is replaced with a marker, because
 *     the alternative — a 400 — costs the whole batch, and the batch is most
 *     valuable precisely when the client is in a state it did not anticipate.
 */
@Injectable()
export class ActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
  ) {}

  async ingest(
    consumer: GatewayConsumer,
    dto: IngestActivityDto,
    request: Request,
  ) {
    const local = await this.consumers.resolve(consumer);
    const now = Date.now();
    // The peer as APISIX saw it — see client-ip.ts for why req.ip is the
    // trustworthy read here and a forwarded header is not.
    const ip = clientIp(request) || null;
    const ua = request.headers['user-agent'];
    const userAgent =
      typeof ua === 'string' ? ua.slice(0, USER_AGENT_MAX) : null;

    const rows = dto.events.map((event) =>
      this.toRow(event, {
        consumerId: local.id,
        now,
        ip,
        userAgent,
      }),
    );

    // One statement for the whole batch — a flush of a hundred events is one
    // round trip, not a hundred. `skipDuplicates` is what makes a client's
    // retry of an unacknowledged flush safe (see the `eventId` unique index).
    const written = await this.prisma.activityEvent.createMany({
      data: rows,
      skipDuplicates: true,
    });

    return {
      accepted: written.count,
      duplicates: rows.length - written.count,
    };
  }

  /** Map one reported event onto a row, applying every ingest-time bound. */
  private toRow(
    event: ActivityEventDto,
    ctx: {
      consumerId: string;
      now: number;
      ip: string | null;
      userAgent: string | null;
    },
  ): Prisma.ActivityEventCreateManyInput {
    return {
      consumerId: ctx.consumerId,
      eventId: event.eventId ?? null,
      source: event.source ?? 'sdk',
      level: event.level ?? 'info',
      category: event.category ?? 'event',
      type: event.type,
      message: event.message
        ? event.message.slice(0, ACTIVITY_MESSAGE_MAX)
        : null,
      sessionId: event.sessionId ?? null,
      distinctId: event.distinctId ?? null,
      appVersion: event.appVersion ?? null,
      platform: event.platform ?? null,
      network: event.network ?? null,
      durationMs: event.durationMs ?? null,
      props: boundedProps(event.props),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      occurredAt: clampOccurredAt(event.occurredAt, ctx.now),
    };
  }

  // ── The feed ────────────────────────────────────────────────────────────────
  async list(consumer: GatewayConsumer, query: QueryActivityDto) {
    const local = await this.consumers.resolve(consumer);
    const where = whereFor(local.id, query);

    const [rows, total] = await Promise.all([
      this.prisma.activityEvent.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        take: query.take,
        skip: query.skip,
      }),
      this.prisma.activityEvent.count({ where }),
    ]);

    const data = rows.map((r) => ({
      id: r.id,
      source: r.source,
      level: r.level,
      category: r.category,
      type: r.type,
      message: r.message,
      sessionId: r.sessionId,
      distinctId: r.distinctId,
      appVersion: r.appVersion,
      platform: r.platform,
      network: r.network,
      durationMs: r.durationMs,
      props: (r.props ?? null) as Record<string, unknown> | null,
      ip: r.ip,
      userAgent: r.userAgent,
      at: r.occurredAt,
      receivedAt: r.createdAt,
    }));

    return page(data, total, query);
  }

  // ── The rollup ──────────────────────────────────────────────────────────────
  /**
   * Counts for the window, aggregated in PostgreSQL rather than by reducing the
   * rows in Node — this is the table that grows fastest in the service, and an
   * unbounded `findMany` here would block every other in-flight request while
   * it reduced.
   */
  async summary(consumer: GatewayConsumer, query: ActivitySummaryQueryDto) {
    const local = await this.consumers.resolve(consumer);
    const since = new Date(Date.now() - (query.days - 1) * DAY_MS);
    const where: Prisma.ActivityEventWhereInput = {
      consumerId: local.id,
      occurredAt: { gte: since },
      ...(query.source ? { source: query.source } : {}),
    };
    // `Prisma.empty` rather than an interpolated string: the fragment is still a
    // parameterized clause, so a source that ever stops being a closed enum
    // cannot become an injection point.
    const sourceClause = query.source
      ? Prisma.sql`AND "source" = ${query.source}`
      : Prisma.empty;

    const [
      total,
      levels,
      sources,
      categories,
      topTypes,
      topErrors,
      distinct,
      seriesRows,
    ] = await Promise.all([
      this.prisma.activityEvent.count({ where }),
      this.prisma.activityEvent.groupBy({
        by: ['level'],
        where,
        _count: { _all: true },
      }),
      this.prisma.activityEvent.groupBy({
        by: ['source'],
        where,
        _count: { _all: true },
      }),
      this.prisma.activityEvent.groupBy({
        by: ['category'],
        where,
        _count: { _all: true },
      }),
      this.prisma.activityEvent.groupBy({
        by: ['type'],
        where,
        _count: { _all: true },
        orderBy: { _count: { type: 'desc' } },
        take: ACTIVITY_SUMMARY_TOP_N,
      }),
      this.prisma.activityEvent.groupBy({
        by: ['message'],
        where: { ...where, level: 'error', message: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { message: 'desc' } },
        take: ACTIVITY_SUMMARY_TOP_N,
      }),
      this.prisma.$queryRaw<{ sessions: bigint; devices: bigint }[]>`
        SELECT COUNT(DISTINCT "sessionId")  AS sessions,
               COUNT(DISTINCT "distinctId") AS devices
        FROM "activity_event"
        WHERE "consumerId" = ${local.id}
          AND "occurredAt" >= ${since}
          ${sourceClause}
      `,
      this.prisma.$queryRaw<{ day: Date; count: bigint; errors: bigint }[]>`
        SELECT date_trunc('day', "occurredAt")          AS day,
               COUNT(*)                                 AS count,
               COUNT(*) FILTER (WHERE "level" = 'error') AS errors
        FROM "activity_event"
        WHERE "consumerId" = ${local.id}
          AND "occurredAt" >= ${since}
          ${sourceClause}
        GROUP BY 1
      `,
    ]);

    return {
      total,
      sessions: toCount(distinct[0]?.sessions ?? 0),
      devices: toCount(distinct[0]?.devices ?? 0),
      levels: counted(levels, (r) => r.level),
      sources: counted(sources, (r) => r.source),
      categories: counted(categories, (r) => r.category),
      topTypes: counted(topTypes, (r) => r.type),
      topErrors: counted(topErrors, (r) => r.message),
      series: seedSeries(seriesRows, query.days),
    };
  }
}

/** Everything that narrows the feed. None of these can widen it past the consumer. */
function whereFor(
  consumerId: string,
  query: QueryActivityDto,
): Prisma.ActivityEventWhereInput {
  const occurredAt: Prisma.DateTimeFilter = {};
  if (query.since) occurredAt.gte = new Date(query.since);
  if (query.until) occurredAt.lte = new Date(query.until);

  return {
    consumerId,
    ...(query.source ? { source: query.source } : {}),
    ...(query.level ? { level: { in: levelsAtLeast(query.level) } } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(query.type ? { type: { startsWith: query.type } } : {}),
    ...(query.network ? { network: query.network } : {}),
    ...(Object.keys(occurredAt).length ? { occurredAt } : {}),
  };
}

/**
 * `groupBy` rows as `{ key, count }`, biggest first.
 *
 * The grouped column is read by an accessor rather than by name: indexing the
 * row with a string erases the type, and the version that did stringified
 * whatever it found — so a mistyped column name became the label `undefined` in
 * the dashboard instead of a compile error here.
 */
function counted<T extends { _count: { _all: number } }>(
  rows: T[],
  key: (row: T) => string | null,
): { key: string; count: number }[] {
  return rows
    .map((r) => ({ key: key(r) ?? '', count: r._count._all }))
    .sort((a, b) => b.count - a.count);
}

/**
 * `props`, or a marker when it is too big to keep.
 *
 * Replaced rather than rejected: knowing that `swap.failed` fired matters more
 * than the detail that made it oversized, and a client that starts attaching a
 * whole Horizon response should not lose its error stream over it.
 */
function boundedProps(
  props: Record<string, unknown> | undefined,
): Prisma.InputJsonValue | undefined {
  if (!props) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(props);
  } catch {
    // A cycle, or a BigInt. The event itself is still worth keeping.
    return ACTIVITY_PROPS_OVERSIZED;
  }
  return Buffer.byteLength(serialized) > ACTIVITY_PROPS_MAX_BYTES
    ? ACTIVITY_PROPS_OVERSIZED
    : (props as Prisma.InputJsonValue);
}

/**
 * The client's timestamp, or the receipt time when its clock cannot be trusted.
 *
 * A device an hour fast would otherwise file every event in the future, where a
 * newest-first list pins it to the top permanently. The backward bound is much
 * looser because an offline wallet legitimately has days-old events to flush.
 */
function clampOccurredAt(raw: string | undefined, now: number): Date {
  if (!raw) return new Date(now);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return new Date(now);
  if (at > now + ACTIVITY_MAX_CLOCK_SKEW_AHEAD_MS) return new Date(now);
  if (at < now - ACTIVITY_MAX_BACKFILL_MS) return new Date(now);
  return new Date(at);
}

/** Daily buckets with the quiet days filled in, oldest first. */
function seedSeries(
  rows: { day: Date; count: bigint; errors: bigint }[],
  days: number,
): { date: string; count: number; errors: number }[] {
  const byDay = new Map(
    rows.map((r) => [
      r.day.toISOString().slice(0, 10),
      { count: toCount(r.count), errors: toCount(r.errors) },
    ]),
  );
  const out: { date: string; count: number; errors: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    const hit = byDay.get(date);
    out.push({ date, count: hit?.count ?? 0, errors: hit?.errors ?? 0 });
  }
  return out;
}
