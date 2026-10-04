/**
 * Answers the settlement-precedence query (`settlementRivalsQuery` in
 * `src/payment-intents/settlement-rivals.ts`) over an e2e suite's in-memory
 * intents, or `null` when `args` is some other `findMany`.
 *
 * A mock that returned every row for it would make each settlement compete
 * with every other intent in the suite, whoever owns it. Supports what that
 * query uses: AND / OR, equality, `not`, `notIn`, `in` and `lt` (dates by
 * time), ordered by `createdAt` then `id`, cut at `take`.
 */
export function rivalsOf(
  rows: Iterable<Record<string, any>>,
  args: { where?: any; take?: number } | undefined,
): Record<string, any>[] | null {
  if (!args?.where?.AND) return null;
  return [...rows]
    .filter((row) => matches(row, args.where))
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, args.take);
}

function matches(row: Record<string, any>, where: any): boolean {
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === 'AND') return cond.every((w: any) => matches(row, w));
    if (key === 'OR') return cond.some((w: any) => matches(row, w));
    const value = time(row[key]);
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('not' in cond) return value !== cond.not;
      if ('notIn' in cond) return !cond.notIn.includes(value);
      if ('in' in cond) return cond.in.includes(value);
      if ('lt' in cond) return value < time(cond.lt);
      throw new Error(`rivalsOf: unsupported filter on ${key}`);
    }
    return value === time(cond);
  });
}

function time(value: unknown): any {
  return value instanceof Date ? value.getTime() : value;
}
