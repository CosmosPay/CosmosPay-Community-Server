import { Prisma } from '@generated/prisma/client';
import {
  SERIES_OUTCOMES,
  type SeriesOutcome,
} from '@/analytics/analytics.constants';

/**
 * The status tables of `analytics.constants.ts` (`SWAP_OUTCOMES` and its siblings) turned into
 * SQL for `GET /v1/summary/series`. Pure, so a spec pins the exact text without a database.
 *
 * The statuses are spliced in as SQL text (`Prisma.raw`) rather than bound: every `status`
 * column counted here is a Postgres enum, which a literal casts to and a text parameter does
 * not, and the labels are this service's own constants, never anything a caller sent. A label
 * that is not a plain enum identifier throws instead of reaching the SQL.
 */

/** A Prisma enum label: upper case letters and underscores, nothing to quote or escape. */
const ENUM_LABEL = /^[A-Z][A-Z_]*$/;

/** The statuses `outcomes` maps to `outcome`, in the table's order. */
export function statusesFor<S extends string>(
  outcomes: Record<S, SeriesOutcome>,
  outcome: SeriesOutcome,
): S[] {
  return (Object.keys(outcomes) as S[]).filter(
    (status) => outcomes[status] === outcome,
  );
}

function quoted(statuses: readonly string[]): string {
  return statuses
    .map((status) => {
      if (!ENUM_LABEL.test(status)) {
        throw new Error(`Not an enum label: ${JSON.stringify(status)}`);
      }
      return `'${status}'`;
    })
    .join(', ');
}

/**
 * `"status" IN (...)` over the statuses `outcomes` maps to `outcome`, for a `FILTER (WHERE ...)`.
 * `FALSE` when the table maps none there, since `IN ()` is a syntax error.
 */
export function statusIn<S extends string>(
  outcomes: Record<S, SeriesOutcome>,
  outcome: SeriesOutcome,
): Prisma.Sql {
  const statuses = statusesFor(outcomes, outcome);
  return Prisma.raw(
    statuses.length ? `"status" IN (${quoted(statuses)})` : 'FALSE',
  );
}

/**
 * A `CASE` naming each row's outcome (`'succeeded'`, `'failed'` or `'inProgress'`) from its
 * status, so rows of tables with different status enums can be counted together. It has no
 * `ELSE`: the tables are exhaustive by type, and a status outside them would count in `count`
 * and in no outcome rather than be guessed into one.
 */
export function outcomeCase<S extends string>(
  outcomes: Record<S, SeriesOutcome>,
): Prisma.Sql {
  const arms = SERIES_OUTCOMES.flatMap((outcome) => {
    const statuses = statusesFor(outcomes, outcome);
    return statuses.length
      ? [`WHEN "status" IN (${quoted(statuses)}) THEN '${outcome}'`]
      : [];
  });
  if (!arms.length) throw new Error('An outcome table maps no status');
  return Prisma.raw(`CASE ${arms.join(' ')} END`);
}
