import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type {
  ZkAuditedTransfer,
  ZkTransactionRead,
} from '@/zk-payments/confidential-sdk';
import {
  CONFIDENTIAL_TRANSFER_FUNCTION,
  ZK_TX_CREATED_AT_SKEW_MS,
} from '@/zk-payments/zk-payments.constants';

/** What a private payment requires of its two transfers. */
export interface ZkSettlementTerms {
  /** The confidential token both transfers must be made on (C...). */
  token: string;
  network: string;
  /** The merchant: the payment transfer's recipient. */
  recipient: string;
  /** Cosmos Pay's fee account: the fee transfer's recipient. */
  feeAccount: string;
  /** What the merchant must receive, in stroops. */
  netStroops: bigint;
  /** What the fee account must receive, in stroops. */
  feeStroops: bigint;
  createdAt: Date;
  expiresAt: Date;
}

/** A settlement the chain backs. */
export interface ZkSettlement {
  /** The account both transfers came from. */
  payer: string;
  /** The later of the two close times: when the payment was complete. */
  settledAt: Date;
}

type Leg = 'payment' | 'fee';

const MISMATCH: Record<Leg, ApiErrorCode> = {
  payment: ApiErrorCode.PaymentTransferMismatch,
  fee: ApiErrorCode.FeeTransferMismatch,
};

const LEG_LABEL: Record<Leg, string> = {
  payment: 'payment',
  fee: 'fee',
};

/** What each leg must pay: the recipient and the exact amount in stroops. */
function legTarget(
  terms: ZkSettlementTerms,
  leg: Leg,
): { to: string; stroops: bigint; what: string } {
  return leg === 'payment'
    ? {
        to: terms.recipient,
        stroops: terms.netStroops,
        what: "a confidential transfer of the payment's net amount to its recipient",
      }
    : {
        to: terms.feeAccount,
        stroops: terms.feeStroops,
        what: 'a confidential transfer of the commission to the fee account',
      };
}

/**
 * Decides whether two transactions settle a private payment, from what the chain
 * says they did (`ConfidentialSdk.readTransaction`). Throws the `ApiError` the
 * confirm route answers with; returns the payer and the settlement time.
 *
 * The ORDER of the checks is part of the security, because the route is
 * public and decrypts what it is given with the auditor key, and the amount is
 * the one thing a confidential transfer hides:
 *
 *  1. both transactions exist and succeeded;
 *  2. each is one operation calling `confidential_transfer` on OUR token, with
 *     exactly one `transfer` event;
 *  3. each closed while this payment was open: not before it was created (less
 *     a minute of clock skew), not after it expired;
 *  4. both come from the same payer;
 *  5. each goes to the right recipient;
 *  6. and only then, each decrypts, under both auditor channels and against
 *     the commitment, to exactly the amount it must pay.
 *
 * Steps 3 and 4 come before any amount is compared so that this cannot be used
 * as an oracle on someone else's transfer: a payment created after a transfer
 * closed refuses it at step 3, and a fee transfer of one's own cannot vouch for
 * a stranger's payment transfer at step 4. No message ever says what an amount
 * decrypted to, only that it is not the one required.
 */
export function verifyZkSettlement(
  terms: ZkSettlementTerms,
  payment: ZkTransactionRead,
  fee: ZkTransactionRead,
): ZkSettlement {
  // 1 + 2: both legs exist, succeeded and have the right shape.
  const paid = theTransfer(terms, 'payment', payment);
  const charged = theTransfer(terms, 'fee', fee);

  // 3: both happened while the payment was open.
  assertWindow(terms, 'payment', paid.closedAt);
  assertWindow(terms, 'fee', charged.closedAt);

  // 4: one payer.
  if (paid.transfer.from !== charged.transfer.from) {
    throw ApiError.badRequest(
      ApiErrorCode.PayerMismatch,
      'The payment and fee transfers must come from the same account; they ' +
        'come from two different ones.',
    );
  }

  // 5 + 6: right recipient, then the right amount.
  assertPays(terms, 'payment', paid.transfer);
  assertPays(terms, 'fee', charged.transfer);

  return {
    payer: paid.transfer.from,
    settledAt:
      paid.closedAt > charged.closedAt ? paid.closedAt : charged.closedAt,
  };
}

/** Steps 1 and 2 for one leg: the single confidential transfer it made. */
function theTransfer(
  terms: ZkSettlementTerms,
  leg: Leg,
  read: ZkTransactionRead,
): { transfer: ZkAuditedTransfer; closedAt: Date } {
  if (read.status === 'not_found') {
    throw ApiError.badRequest(
      ApiErrorCode.TransactionNotFound,
      `Transaction ${read.txHash} was not found on ${terms.network}: it has ` +
        'not closed yet, or it is older than the RPC keeps. Retry in a few seconds.',
    );
  }
  if (read.status === 'failed') {
    throw ApiError.badRequest(
      ApiErrorCode.TransactionRejected,
      `The ${LEG_LABEL[leg]} transaction ${read.txHash} failed on-chain and ` +
        'moved nothing.',
    );
  }
  const mismatch = (why: string) =>
    ApiError.badRequest(
      MISMATCH[leg],
      `The ${LEG_LABEL[leg]} transaction does not settle this private payment: ` +
        `it is not ${legTarget(terms, leg).what}${why ? ` (${why})` : ''}.`,
    );

  if (
    read.operationCount !== 1 ||
    read.invocation?.contract !== terms.token ||
    read.invocation.function !== CONFIDENTIAL_TRANSFER_FUNCTION
  ) {
    throw mismatch(
      `it must be a single ${CONFIDENTIAL_TRANSFER_FUNCTION} call on ${terms.token}`,
    );
  }
  if (read.transfers.length !== 1) {
    throw mismatch(
      `it must make exactly one confidential transfer, it made ${read.transfers.length}`,
    );
  }
  return { transfer: read.transfers[0], closedAt: read.closedAt };
}

/** Step 3 for one leg. */
function assertWindow(terms: ZkSettlementTerms, leg: Leg, closedAt: Date) {
  const floor = terms.createdAt.getTime() - ZK_TX_CREATED_AT_SKEW_MS;
  if (closedAt.getTime() < floor) {
    throw ApiError.badRequest(
      MISMATCH[leg],
      `The ${LEG_LABEL[leg]} transaction does not settle this private payment: it ` +
        `closed at ${closedAt.toISOString()}, before this payment was created.`,
    );
  }
  if (closedAt.getTime() > terms.expiresAt.getTime()) {
    throw ApiError.badRequest(
      ApiErrorCode.Expired,
      `The ${LEG_LABEL[leg]} transaction closed at ${closedAt.toISOString()}, ` +
        `after this private payment expired at ${terms.expiresAt.toISOString()}.`,
    );
  }
}

/** Steps 5 and 6 for one leg. */
function assertPays(
  terms: ZkSettlementTerms,
  leg: Leg,
  transfer: ZkAuditedTransfer,
): void {
  const target = legTarget(terms, leg);
  const mismatch = (why: string) =>
    ApiError.badRequest(
      MISMATCH[leg],
      `The ${LEG_LABEL[leg]} transaction does not settle this private payment: ` +
        `it is not ${target.what} (${why}).`,
    );
  if (transfer.to !== target.to) {
    throw mismatch(`it pays ${transfer.to}, not ${target.to}`);
  }
  // One answer for every way the amount can be wrong: a wrong key, a
  // commitment that does not open, or another value. Saying which would say
  // something about a hidden amount.
  if (
    transfer.amount === null ||
    !transfer.channelsAgree ||
    transfer.commitmentMatches !== true ||
    transfer.amount !== target.stroops
  ) {
    throw mismatch('the amount is not the one this payment requires');
  }
}
