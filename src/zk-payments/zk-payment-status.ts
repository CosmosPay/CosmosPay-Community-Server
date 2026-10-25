import type { Prisma, ZkPaymentStatus } from '@generated/prisma/client';

/**
 * The status a ZK payment READS as at `now`.
 *
 * Nothing stores EXPIRED: no timer sweeps ZK payments, and an expired payment
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
