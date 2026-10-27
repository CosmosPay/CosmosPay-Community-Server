import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type {
  ZkAuditedTransfer,
  ZkTransactionRead,
} from '@/zk-payments/confidential-sdk';
import {
  CONFIDENTIAL_TRANSFER_FUNCTION,
  ZK_TX_CREATED_AT_SKEW_MS,
} from '@/zk-payments/zk-payments.constants';

/** What a private payment requires of its transfers (two, or three with a merchant fee). */
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
  /** The merchant fee's transfer: its wallet and amount in stroops; null without one. */
  merchantFee: { wallet: string; stroops: bigint } | null;
  createdAt: Date;
  expiresAt: Date;
}

/** A settlement the chain backs. */
export interface ZkSettlement {
  /** The account every transfer came from. */
  payer: string;
  /** The latest of the close times: when the payment was complete. */
  settledAt: Date;
}

type Leg = 'payment' | 'fee' | 'merchantFee';

const MISMATCH: Record<Leg, ApiErrorCode> = {
  payment: ApiErrorCode.PaymentTransferMismatch,
  fee: ApiErrorCode.FeeTransferMismatch,
  merchantFee: ApiErrorCode.MerchantFeeTransferMismatch,
};

const LEG_LABEL: Record<Leg, string> = {
  payment: 'payment',
  fee: 'fee',
  merchantFee: 'merchant fee',
};

/** What each leg must pay: the recipient and the exact amount in stroops. */
const LEG_TARGETS: Record<
  Leg,
  (terms: ZkSettlementTerms) => { to: string; stroops: bigint; what: string }
> = {
  payment: (terms) => ({
    to: terms.recipient,
    stroops: terms.netStroops,
    what: "a confidential transfer of the payment's net amount to its recipient",
  }),
  fee: (terms) => ({
    to: terms.feeAccount,
    stroops: terms.feeStroops,
    what: 'a confidential transfer of the commission to the fee account',
  }),
  merchantFee: (terms) => {
    if (!terms.merchantFee) {
      throw new Error('a merchant fee leg needs a merchant fee in the terms');
    }
    return {
      to: terms.merchantFee.wallet,
      stroops: terms.merchantFee.stroops,
      what: "a confidential transfer of the merchant fee to the fee's wallet",
    };
  },
};

function legTarget(terms: ZkSettlementTerms, leg: Leg) {
  return LEG_TARGETS[leg](terms);
}

/**
 * Decides whether the transactions settle a private payment, from what the chain
 * says they did (`ConfidentialSdk.readTransaction`): the payment and the fee,
 * plus the merchant fee's when the payment has one (`terms.merchantFee`). Throws
 * the `ApiError` the confirm route answers with; returns the payer and the
 * settlement time.
 *
 * The ORDER of the checks is part of the security, because the route is
 * public and decrypts what it is given with the auditor key, and the amount is
 * the one thing a confidential transfer hides. Each step runs over every leg
 * before the next one starts:
 *
 *  1. every transaction exists and succeeded;
 *  2. each is one operation calling `confidential_transfer` on OUR token, with
 *     exactly one `transfer` event;
 *  3. each closed while this payment was open: not before it was created (less
 *     a minute of clock skew), not after it expired;
 *  4. all come from the same payer;
 *  5. each goes to the right recipient;
 *  6. and only then, each decrypts, under both auditor channels and against
 *     the commitment, to exactly the amount it must pay.
 *
 * Steps 3 and 4 come before any amount is compared so that this cannot be used
 * as an oracle on someone else's transfer: a payment created after a transfer
 * closed refuses it at step 3, and a fee transfer of one's own cannot vouch for
 * a stranger's payment or merchant fee transfer at step 4. No message ever says
 * what an amount decrypted to, only that it is not the one required.
 *
 * @throws Error when `merchantFee` is given without a merchant fee in the
 *   terms, or the other way round: the caller decides which legs there are.
 */
export function verifyZkSettlement(
  terms: ZkSettlementTerms,
  payment: ZkTransactionRead,
  fee: ZkTransactionRead,
  merchantFee: ZkTransactionRead | null = null,
): ZkSettlement {
  if ((terms.merchantFee === null) !== (merchantFee === null)) {
    throw new Error(
      'the merchant fee transaction and the merchant fee terms go together',
    );
  }
  const reads: [Leg, ZkTransactionRead][] = [
    ['payment', payment],
    ['fee', fee],
  ];
  if (merchantFee) reads.push(['merchantFee', merchantFee]);

  // 1 + 2: every leg exists, succeeded and has the right shape.
  const legs = reads.map(([leg, read]) => ({
    leg,
    ...theTransfer(terms, leg, read),
  }));

  // 3: all of them happened while the payment was open.
  for (const { leg, closedAt } of legs) assertWindow(terms, leg, closedAt);

  // 4: one payer.
  const payer = legs[0].transfer.from;
  if (legs.some(({ transfer }) => transfer.from !== payer)) {
    throw ApiError.badRequest(
      ApiErrorCode.PayerMismatch,
      legs.length === 2
        ? 'The payment and fee transfers must come from the same account; ' +
            'they come from two different ones.'
        : 'The payment, fee and merchant fee transfers must all come from ' +
            'the same account; they do not.',
    );
  }

  // 5 + 6: right recipient, then the right amount.
  for (const { leg, transfer } of legs) assertPays(terms, leg, transfer);

  return {
    payer,
    settledAt: legs.reduce(
      (latest, { closedAt }) => (closedAt > latest ? closedAt : latest),
      legs[0].closedAt,
    ),
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
