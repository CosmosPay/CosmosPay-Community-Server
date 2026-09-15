/**
 * The envelope every list endpoint returns.
 *
 * `total` is the number of matching rows, never `data.length`. That distinction
 * is the whole point: on a full page `data.length` always equals `take`, so a
 * caller paginating on it can never tell a full page from the last one.
 *
 * Read the page and the count with `Promise.all`, not `$transaction([...])`.
 * The transaction bought no consistency: Postgres runs it at READ COMMITTED,
 * where each statement takes its own snapshot, so the page and the count could
 * disagree inside it just as they can outside — and the client is paging a list
 * that moves between requests anyway. What it did cost was four serial round
 * trips on one connection (BEGIN, page, count, COMMIT) instead of two queries in
 * parallel.
 */
export interface Page<T> {
  data: T[];
  total: number;
  take: number;
  skip: number;
}

/** Builds a {@link Page} from a query's rows, count and bounds. */
export function page<T>(
  data: T[],
  total: number,
  bounds: { take: number; skip: number },
): Page<T> {
  return { data, total, take: bounds.take, skip: bounds.skip };
}
