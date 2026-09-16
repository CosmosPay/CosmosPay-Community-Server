/**
 * The columns a `*_PUBLIC_SELECT` names, taken from a row that was read whole.
 *
 * Some services need the full row internally — the relay reads
 * `settlementEpoch`, the observer `lastCheckedAt` — and still have to answer
 * with the public projection. A spread (`{ ...row }`) answers with every
 * column instead, including internal ids and any column added later. This
 * applies the same allowlist the query-side `select` does, to a row already in
 * hand, so one constant decides what leaves the service on both paths.
 */
export function project<
  Row extends object,
  Select extends { readonly [K in keyof Row]?: true },
>(row: Row, select: Select): Pick<Row, Extract<keyof Select, keyof Row>> {
  const out = {} as Pick<Row, Extract<keyof Select, keyof Row>>;
  for (const key of Object.keys(select) as Extract<keyof Select, keyof Row>[]) {
    out[key] = row[key];
  }
  return out;
}
