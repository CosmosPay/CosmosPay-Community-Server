/**
 * An in-memory stand-in for the Prisma tables the `koywe` plugin's specs
 * touch, with the filters the plugin writes: equality (dates by time), null,
 * `in`, `not`, `gt` / `gte` / `lt` / `lte`, `OR`, compound unique keys
 * (`a_b: { a, b }`), `select`, `orderBy` on one field and `take`. Each
 * statement runs whole, as Postgres would; a unique key taken twice throws a
 * P2002 like the client. Named `*.fake-spec.ts`: kept out of the build and not
 * a suite of its own.
 */

export type Row = Record<string, unknown>;

/** The error the Prisma client throws on a unique violation. */
export class UniqueViolation extends Error {
  readonly code = 'P2002';
  constructor(readonly fields: string[]) {
    super(`Unique constraint failed on the fields: (${fields.join(', ')})`);
  }
}

const same = (a: unknown, b: unknown): boolean =>
  a instanceof Date && b instanceof Date
    ? a.getTime() === b.getTime()
    : a === b;

function compare(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number | string);
  const y = b instanceof Date ? b.getTime() : (b as number | string);
  return x < y ? -1 : x > y ? 1 : 0;
}

function fieldMatches(value: unknown, want: unknown): boolean {
  if (
    want !== null &&
    typeof want === 'object' &&
    !(want instanceof Date) &&
    !Array.isArray(want)
  ) {
    const filter = want as Row;
    return Object.entries(filter).every(([op, operand]) => {
      switch (op) {
        case 'in':
          return (operand as unknown[]).some((v) => same(value, v));
        case 'not':
          return operand === null
            ? value !== null && value !== undefined
            : !same(value, operand);
        case 'gt':
          return value != null && compare(value, operand) > 0;
        case 'gte':
          return value != null && compare(value, operand) >= 0;
        case 'lt':
          return value != null && compare(value, operand) < 0;
        case 'lte':
          return value != null && compare(value, operand) <= 0;
        default:
          throw new Error(`memory db: no filter "${op}"`);
      }
    });
  }
  if (want === null) return value === null || value === undefined;
  return same(value, want);
}

export function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([field, want]) => {
    if (field === 'OR') return (want as Row[]).some((w) => matches(row, w));
    if (field === 'AND') return (want as Row[]).every((w) => matches(row, w));
    if (
      field.includes('_') &&
      want &&
      typeof want === 'object' &&
      !(want instanceof Date)
    ) {
      // A compound unique key: `a_b: { a, b }`.
      return matches(row, want as Row);
    }
    return fieldMatches(row[field], want);
  });
}

function pick(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => select[key])
      .map((key) => [key, row[key] ?? null]),
  );
}

/** One table: `uniques` lists the column sets no two rows may share (all non-null). */
export function memoryTable(
  prefix: string,
  defaults: Row = {},
  uniques: string[][] = [],
) {
  const rows: Row[] = [];
  let next = 1;
  const clash = (candidate: Row, except?: Row) =>
    uniques.find((fields) =>
      rows.some(
        (row) =>
          row !== except &&
          fields.every(
            (f) => candidate[f] != null && same(row[f], candidate[f]),
          ),
      ),
    );
  const table = {
    rows,
    create: jest.fn(({ data, select }: { data: Row; select?: Row }) => {
      const row: Row = {
        id: `${prefix}${next++}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...defaults,
        ...data,
      };
      const taken = clash(row);
      if (taken) return Promise.reject(new UniqueViolation(taken));
      rows.push(row);
      return Promise.resolve(pick(row, select));
    }),
    findUnique: jest.fn(({ where, select }: { where: Row; select?: Row }) => {
      const row = rows.find((r) => matches(r, where));
      return Promise.resolve(row ? pick(row, select) : null);
    }),
    findFirst: jest.fn(({ where, select }: { where: Row; select?: Row }) => {
      const row = rows.find((r) => matches(r, where));
      return Promise.resolve(row ? pick(row, select) : null);
    }),
    findMany: jest.fn(
      ({
        where,
        select,
        orderBy,
        take,
      }: {
        where?: Row;
        select?: Row;
        orderBy?: Record<string, 'asc' | 'desc'>;
        take?: number;
      }) => {
        let found = rows.filter((r) => matches(r, where));
        if (orderBy) {
          const [[field, direction]] = Object.entries(orderBy);
          found = [...found].sort(
            (a, b) =>
              compare(a[field] ?? 0, b[field] ?? 0) *
              (direction === 'desc' ? -1 : 1),
          );
        }
        return Promise.resolve(
          found.slice(0, take ?? found.length).map((r) => pick(r, select)),
        );
      },
    ),
    update: jest.fn(
      ({ where, data, select }: { where: Row; data: Row; select?: Row }) => {
        const row = rows.find((r) => matches(r, where));
        if (!row)
          return Promise.reject(new Error('memory db: no row to update'));
        const taken = clash({ ...row, ...data }, row);
        if (taken) return Promise.reject(new UniqueViolation(taken));
        Object.assign(row, data, { updatedAt: new Date() });
        return Promise.resolve(pick(row, select));
      },
    ),
    updateMany: jest.fn(({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data, { updatedAt: new Date() }));
      return Promise.resolve({ count: hit.length });
    }),
    deleteMany: jest.fn(({ where }: { where: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
      return Promise.resolve({ count: hit.length });
    }),
  };
  return table;
}

/** The plugin's tables, with their unique keys, and `$transaction` over them. */
export function koyweDb() {
  const tables = {
    bankTransferAccount: memoryTable(
      'acct',
      {
        status: 'pending',
        reason: null,
        verificationUrl: null,
        providerMerchantId: null,
        kybId: null,
        kybCheckedAt: null,
        virtualAccountId: null,
        alias: null,
        cvu: null,
        bank: null,
      },
      [
        ['consumerId', 'network'],
        ['network', 'providerMerchantId'],
      ],
    ),
    bankTransfer: memoryTable(
      'btr',
      {
        status: 'awaiting_deposit',
        depositAmount: null,
        depositReference: null,
        depositedAt: null,
        providerQuoteId: null,
        providerOrderId: null,
        providerStatus: null,
        reason: null,
        attempts: 0,
        nextAttemptAt: null,
        checkedAt: null,
        deliveredAmount: null,
        txHash: null,
        completedAt: null,
        failedAt: null,
      },
      [['paymentRequestId', 'documentHash'], ['providerOrderId']],
    ),
    bankTransferWebhookEvent: memoryTable('evt', { processedAt: null }, [
      ['id'],
    ]),
    bankIncomeEvent: memoryTable('inc', {}, [['eventId']]),
    bankTransferCryptoAccount: memoryTable('cacc', {}, [
      ['network', 'merchantId', 'providerNetwork', 'token', 'address'],
    ]),
  };
  const $transaction = jest.fn(
    <T>(work: (tx: typeof tables) => Promise<T>): Promise<T> => work(tables),
  );
  return { ...tables, $transaction };
}
