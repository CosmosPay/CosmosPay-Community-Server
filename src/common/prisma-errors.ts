/**
 * True for a Prisma unique-constraint violation (P2002).
 * Shared by payment intents, swaps, and webhook terminal dedup.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002';
}

/**
 * The columns a P2002 names, from whichever place the client reported them.
 *
 * Prisma's own path is `meta.target`. Through `@prisma/adapter-pg` that is unset
 * and the violation arrives under `meta.driverAdapterError` instead, so a caller
 * reading only the target sees an empty list and has to guess which unique index
 * fired — and both guesses are wrong for one case: "assume it is mine" turns
 * another column's collision into the wrong 409, "assume it is not" drops the
 * right one. The adapter does carry the constraint, whose name contains the
 * column (`payment_intent_consumerId_txHash_key`), so read that too and let the
 * caller match on it.
 *
 * Still empty means the client said nothing at all about which index it was;
 * a caller that must answer anyway decides for itself, in one place, knowingly.
 */
export function uniqueViolationColumns(err: unknown): string[] {
  const target = (err as { meta?: { target?: unknown } })?.meta?.target;
  if (Array.isArray(target)) {
    const named = target.filter((t): t is string => typeof t === 'string');
    if (named.length > 0) return named;
  }
  if (typeof target === 'string' && target) return [target];
  return adapterConstraint(err);
}

/** Whether a P2002 names `column`, by field name or inside a constraint name. */
export function uniqueViolationNames(err: unknown, column: string): boolean {
  const needle = column.toLowerCase();
  return uniqueViolationColumns(err).some((name) =>
    name.toLowerCase().includes(needle),
  );
}

/** Constraint fields, or the index name, as a driver adapter reports them. */
function adapterConstraint(err: unknown): string[] {
  const cause = (
    err as {
      meta?: { driverAdapterError?: { cause?: unknown } };
    }
  )?.meta?.driverAdapterError?.cause as
    { constraint?: { fields?: unknown; index?: unknown } } | undefined;
  const constraint = cause?.constraint;
  if (!constraint) return [];
  if (Array.isArray(constraint.fields)) {
    return constraint.fields.filter((f): f is string => typeof f === 'string');
  }
  if (typeof constraint.index === 'string' && constraint.index) {
    return [constraint.index];
  }
  return [];
}
