/**
 * The envelope every list endpoint returns.
 *
 * `total` is the number of matching rows, never `data.length`. That distinction
 * is the whole point: on a full page `data.length` always equals `take`, so a
 * caller paginating on it can never tell a full page from the last one.
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
