import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type {
  ZkAuditedTransfer,
  ZkTransactionRead,
} from '@/zk-payments/confidential-sdk';
import {
  verifyZkSettlement,
  type ZkSettlementTerms,
} from '@/zk-payments/zk-payment-verification';

const TOKEN = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const OTHER_TOKEN = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';
const MERCHANT = 'GACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAJJHP';
const FEE_ACCOUNT = 'GACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKG7N';
const PAYER = 'GADAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDANWXK';
const STRANGER = 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO';

const CREATED = new Date('2026-10-25T14:00:00.000Z');
const EXPIRES = new Date('2026-10-25T15:00:00.000Z');
const PAID_AT = new Date('2026-10-25T14:05:00.000Z');

const terms: ZkSettlementTerms = {
  token: TOKEN,
  network: 'testnet',
  recipient: MERCHANT,
  feeAccount: FEE_ACCOUNT,
  netStroops: 249_975_000n,
  feeStroops: 25_000n,
  createdAt: CREATED,
  expiresAt: EXPIRES,
};

function transfer(over: Partial<ZkAuditedTransfer> = {}): ZkAuditedTransfer {
  return {
    from: PAYER,
    to: MERCHANT,
    amount: 249_975_000n,
    channelsAgree: true,
    commitmentMatches: true,
    ...over,
  };
}

function read(
  over: Partial<Extract<ZkTransactionRead, { status: 'success' }>> = {},
  t: ZkAuditedTransfer = transfer(),
): ZkTransactionRead {
  return {
    status: 'success',
    txHash: 'a'.repeat(64),
    ledger: 100,
    closedAt: PAID_AT,
    operationCount: 1,
    invocation: { contract: TOKEN, function: 'confidential_transfer' },
    transfers: [t],
    ...over,
  };
}

const goodPayment = () => read();
const goodFee = () =>
  read(
    { txHash: 'b'.repeat(64) },
    transfer({ to: FEE_ACCOUNT, amount: 25_000n }),
  );

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof ApiError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof ApiError) {
      return String((err.getResponse() as { message: string }).message);
    }
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('verifyZkSettlement', () => {
  it('settles two transfers that pay the merchant and the fee account exactly', () => {
    const feeLater = read(
      { txHash: 'b'.repeat(64), closedAt: new Date('2026-10-25T14:06:00Z') },
      transfer({ to: FEE_ACCOUNT, amount: 25_000n }),
    );
    expect(verifyZkSettlement(terms, goodPayment(), feeLater)).toEqual({
      payer: PAYER,
      settledAt: new Date('2026-10-25T14:06:00Z'),
    });
  });

  describe('the transactions exist and succeeded', () => {
    it('answers transaction_not_found for a hash the RPC does not have', () => {
      expect(
        codeOf(() =>
          verifyZkSettlement(
            terms,
            { status: 'not_found', txHash: 'a'.repeat(64) },
            goodFee(),
          ),
        ),
      ).toBe(ApiErrorCode.TransactionNotFound);
      expect(
        codeOf(() =>
          verifyZkSettlement(terms, goodPayment(), {
            status: 'not_found',
            txHash: 'b'.repeat(64),
          }),
        ),
      ).toBe(ApiErrorCode.TransactionNotFound);
    });

    it('answers transaction_rejected for a transaction that failed on-chain', () => {
      expect(
        codeOf(() =>
          verifyZkSettlement(terms, goodPayment(), {
            status: 'failed',
            txHash: 'b'.repeat(64),
            ledger: 100,
            closedAt: PAID_AT,
          }),
        ),
      ).toBe(ApiErrorCode.TransactionRejected);
    });
  });

  describe('each is one confidential_transfer on our token', () => {
    it.each([
      [
        'another contract',
        {
          invocation: {
            contract: OTHER_TOKEN,
            function: 'confidential_transfer',
          },
        },
      ],
      [
        'another function',
        { invocation: { contract: TOKEN, function: 'withdraw' } },
      ],
      ['no contract call', { invocation: null }],
      ['more than one operation', { operationCount: 2 }],
      ['no transfer event', { transfers: [] }],
      ['two transfer events', { transfers: [transfer(), transfer()] }],
    ])('refuses a payment leg with %s', (_label, over) => {
      expect(
        codeOf(() => verifyZkSettlement(terms, read(over), goodFee())),
      ).toBe(ApiErrorCode.PaymentTransferMismatch);
    });

    it('names the fee leg when the fee transaction is the wrong shape', () => {
      expect(
        codeOf(() =>
          verifyZkSettlement(
            terms,
            goodPayment(),
            read(
              { operationCount: 2 },
              transfer({ to: FEE_ACCOUNT, amount: 25_000n }),
            ),
          ),
        ),
      ).toBe(ApiErrorCode.FeeTransferMismatch);
    });
  });

  describe('both happened while the payment was open', () => {
    it('refuses a transfer that closed after expiresAt as expired', () => {
      const late = new Date(EXPIRES.getTime() + 1000);
      expect(
        codeOf(() =>
          verifyZkSettlement(terms, read({ closedAt: late }), goodFee()),
        ),
      ).toBe(ApiErrorCode.Expired);
      expect(
        codeOf(() =>
          verifyZkSettlement(
            terms,
            goodPayment(),
            read(
              { closedAt: late },
              transfer({ to: FEE_ACCOUNT, amount: 25_000n }),
            ),
          ),
        ),
      ).toBe(ApiErrorCode.Expired);
    });

    it('accepts a transfer that closed exactly at expiresAt', () => {
      expect(() =>
        verifyZkSettlement(terms, read({ closedAt: EXPIRES }), goodFee()),
      ).not.toThrow();
    });

    it('refuses a transfer that closed before the payment existed', () => {
      const early = new Date(CREATED.getTime() - 61_000);
      expect(
        codeOf(() =>
          verifyZkSettlement(terms, read({ closedAt: early }), goodFee()),
        ),
      ).toBe(ApiErrorCode.PaymentTransferMismatch);
    });

    it('allows a minute of clock skew before createdAt', () => {
      const skewed = new Date(CREATED.getTime() - 59_000);
      expect(() =>
        verifyZkSettlement(terms, read({ closedAt: skewed }), goodFee()),
      ).not.toThrow();
    });
  });

  describe('one payer', () => {
    it('refuses transfers from two different accounts', () => {
      expect(
        codeOf(() =>
          verifyZkSettlement(
            terms,
            goodPayment(),
            read(
              { txHash: 'b'.repeat(64) },
              transfer({ from: STRANGER, to: FEE_ACCOUNT, amount: 25_000n }),
            ),
          ),
        ),
      ).toBe(ApiErrorCode.PayerMismatch);
    });
  });

  describe('the right recipient, then the right amount', () => {
    it('refuses a payment transfer to someone else', () => {
      expect(
        codeOf(() =>
          verifyZkSettlement(
            terms,
            read({}, transfer({ to: STRANGER })),
            goodFee(),
          ),
        ),
      ).toBe(ApiErrorCode.PaymentTransferMismatch);
    });

    it('refuses a fee transfer to someone else', () => {
      expect(
        codeOf(() =>
          verifyZkSettlement(
            terms,
            goodPayment(),
            read({}, transfer({ to: MERCHANT, amount: 25_000n })),
          ),
        ),
      ).toBe(ApiErrorCode.FeeTransferMismatch);
    });

    it.each([
      ['one stroop short', { amount: 249_974_999n }],
      ['one stroop over', { amount: 249_975_001n }],
      ['an undecodable event', { amount: null }],
      ['channels that disagree (a wrong key)', { channelsAgree: false }],
      ['a commitment that does not open', { commitmentMatches: false }],
      ['no commitment to check', { commitmentMatches: null }],
    ])('refuses a payment transfer with %s', (_label, over) => {
      expect(
        codeOf(() =>
          verifyZkSettlement(terms, read({}, transfer(over)), goodFee()),
        ),
      ).toBe(ApiErrorCode.PaymentTransferMismatch);
    });

    it('refuses a fee transfer of the wrong amount', () => {
      expect(
        codeOf(() =>
          verifyZkSettlement(
            terms,
            goodPayment(),
            read({}, transfer({ to: FEE_ACCOUNT, amount: 24_999n })),
          ),
        ),
      ).toBe(ApiErrorCode.FeeTransferMismatch);
    });

    it('never says what the amount decrypted to', () => {
      const message = messageOf(() =>
        verifyZkSettlement(
          terms,
          read({}, transfer({ amount: 123_456_789n })),
          goodFee(),
        ),
      );
      expect(message).not.toMatch(/123456789|12\.3456789/);
      expect(message).toContain(
        'the amount is not the one this payment requires',
      );
    });
  });

  describe('the order is what keeps confirm from being an amount oracle', () => {
    it('refuses a payment created after the transfer on time, before comparing amounts', () => {
      // A transfer of the right amount closed before this payment existed: the
      // window answers, so "right amount" is never distinguishable from "wrong".
      const early = new Date(CREATED.getTime() - 3_600_000);
      const right = messageOf(() =>
        verifyZkSettlement(terms, read({ closedAt: early }), goodFee()),
      );
      const wrong = messageOf(() =>
        verifyZkSettlement(
          terms,
          read({ closedAt: early }, transfer({ amount: 1n })),
          goodFee(),
        ),
      );
      expect(right).toBe(wrong);
      expect(right).toContain('before this payment was created');
    });

    it('refuses a stranger-paid transfer on the payer before comparing amounts', () => {
      const strangerFee = read(
        { txHash: 'b'.repeat(64) },
        transfer({ from: STRANGER, to: FEE_ACCOUNT, amount: 25_000n }),
      );
      expect(
        codeOf(() => verifyZkSettlement(terms, goodPayment(), strangerFee)),
      ).toBe(ApiErrorCode.PayerMismatch);
      expect(
        codeOf(() =>
          verifyZkSettlement(
            terms,
            read({}, transfer({ amount: 1n })),
            strangerFee,
          ),
        ),
      ).toBe(ApiErrorCode.PayerMismatch);
    });
  });
});
