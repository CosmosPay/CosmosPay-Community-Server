import { Prisma, type ZkPaymentStatus } from '@generated/prisma/client';

/**
 * The status a private payment READS as at `now`.
 *
 * Nothing stores EXPIRED: no timer sweeps private payments, and an expired payment
 * is not dead. Transfers that closed before `expiresAt` paid it, so a payer who
 * confirms late still settles it. Every read therefore derives the status, and
 * a PENDING payment past `expiresAt` reads EXPIRED until it settles.
 */
export function effectiveZkStatus(
  row: { status: ZkPaymentStatus; expiresAt: Date },
  now: Date,
): ZkPaymentStatus {
  if (row.status === 'PENDING' && row.expiresAt.getTime() <= now.getTime()) {
    return 'EXPIRED';
  }
  return row.status;
}

/**
 * The `where` that matches payments READING as `status` at `now`, so the list
 * filter and {@link effectiveZkStatus} cannot disagree about a row.
 */
export function zkStatusFilter(
  status: ZkPaymentStatus,
  now: Date,
): Prisma.ZkPaymentWhereInput {
  switch (status) {
    case 'PENDING':
      return { status: 'PENDING', expiresAt: { gt: now } };
    case 'EXPIRED':
      return {
        OR: [
          { status: 'EXPIRED' },
          { status: 'PENDING', expiresAt: { lte: now } },
        ],
      };
    case 'SUCCEEDED':
      return { status: 'SUCCEEDED' };
  }
}

/**
 * The rows of `zk_payment` READING as EXPIRED at `now`, as a SQL condition for the
 * aggregates that count them in Postgres (the dashboard's series): the same rule as
 * {@link effectiveZkStatus} and {@link zkStatusFilter}, so a count and a list agree.
 */
export function zkExpiredSql(now: Date): Prisma.Sql {
  return Prisma.sql`("status" = 'EXPIRED' OR ("status" = 'PENDING' AND "expiresAt" <= ${now}))`;
}
