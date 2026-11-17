import type { PaymentDeposit } from '@generated/prisma/client';
import { treasurySubkey } from '@/sandbox-settlement/sandbox-hd';
import { SANDBOX_NETWORKS } from '@/sandbox-settlement/sandbox-settlement.constants';
import {
  signXrplTransaction,
  xrplAddressOfSecret,
  xrplLastLedgerSequence,
} from '@/sandbox-settlement/sandbox-xrpl.codec';
import {
  XRPL_TEST_USDC_CURRENCY,
  XRPL_TEST_USDC_ISSUER,
  XRPL_TX_VALIDITY_LEDGERS,
} from '@/sandbox-settlement/sandbox-xrpl.constants';
import { SandboxXrplLedger } from '@/sandbox-settlement/sandbox-xrpl.ledger';

const TREASURY_KEY = '0x' + '07'.repeat(32);
const SECRET = treasurySubkey(TREASURY_KEY, 'xrp');
const TREASURY = xrplAddressOfSecret(SECRET);
const MERCHANT = 'rN7Td1t4N7xDW8ohKpcvX1WiACRq9R8Ven';
const PAYER = 'rh1qRFCJcRxWXjcMrNhga2Gkn5hhsALaEM';
const USDC = {
  currency: XRPL_TEST_USDC_CURRENCY,
  issuer: XRPL_TEST_USDC_ISSUER,
};
const OPENED = new Date('2026-11-17T08:00:00Z');

function deposit(overrides: Partial<PaymentDeposit> = {}): PaymentDeposit {
  return {
    id: 'dep_1',
    originChain: 'xrp',
    originContract: XRPL_TEST_USDC_ISSUER,
    originDecimals: 6,
    depositAddress: TREASURY,
    depositMemo: '42',
    createdAt: OPENED,
    ...overrides,
  } as PaymentDeposit;
}

function payment(
  overrides: {
    tag?: number;
    from?: string;
    to?: string;
    value?: string;
    currency?: string;
    result?: string;
    validated?: boolean;
    closed?: string;
  } = {},
) {
  return {
    validated: overrides.validated ?? true,
    close_time_iso: overrides.closed ?? '2026-11-17T08:01:00Z',
    tx_json: {
      TransactionType: 'Payment',
      Account: overrides.from ?? PAYER,
      Destination: overrides.to ?? TREASURY,
      DestinationTag: overrides.tag ?? 42,
    },
    meta: {
      TransactionResult: overrides.result ?? 'tesSUCCESS',
      delivered_amount: {
        currency: overrides.currency ?? XRPL_TEST_USDC_CURRENCY,
        issuer: XRPL_TEST_USDC_ISSUER,
        value: overrides.value ?? '10',
      },
    },
  };
}

function build(client: Record<string, unknown> = {}) {
  const mock = {
    network: () => SANDBOX_NETWORKS.xrp,
    account: jest.fn().mockResolvedValue({
      sequence: 9,
      balance: 50_000_000n,
      ownerCount: 1,
      requireDestinationTag: false,
      depositAuth: false,
    }),
    trustLine: jest.fn().mockResolvedValue({
      account: XRPL_TEST_USDC_ISSUER,
      currency: XRPL_TEST_USDC_CURRENCY,
      balance: '100',
      limit: '1000000000',
      freezePeer: false,
    }),
    reserves: jest
      .fn()
      .mockResolvedValue({ base: 1_000_000n, increment: 200_000n }),
    fee: jest.fn().mockResolvedValue({
      openLedgerFee: 10n,
      baseFee: 10n,
      currentLedger: 22_000_000,
    }),
    accountTx: jest.fn().mockResolvedValue({ transactions: [] }),
    tx: jest.fn().mockResolvedValue({ found: false, searchedAll: false }),
    submit: jest
      .fn()
      .mockResolvedValue({ engineResult: 'tesSUCCESS', message: '' }),
    ...client,
  };
  const config = {
    get: () => ({ treasuryPrivateKey: TREASURY_KEY }),
  } as never;
  return { ledger: new SandboxXrplLedger(config, mock as never), client: mock };
}

const TRANSFER = {
  network: 'xrp' as const,
  token: XRPL_TEST_USDC_ISSUER,
  recipient: MERCHANT,
  amount: 25_000_000n,
};

describe('SandboxXrplLedger', () => {
  it('opens deposits at the treasury, each with its own destination tag', () => {
    const { ledger } = build();
    const a = ledger.newDeposit('xrp');
    const b = ledger.newDeposit('xrp');
    expect(a.address).toBe(TREASURY);
    expect(b.address).toBe(TREASURY);
    expect(a.memo).not.toBe(b.memo);
    expect(Number(a.memo)).toBeGreaterThan(0);
    expect(Number(a.memo)).toBeLessThan(2 ** 32);
    expect(a.locator).toBe(`xrpl:tag:${a.memo}`);
  });

  it('counts what validated test-USDC payments with the tag delivered, and nothing else', async () => {
    const { ledger, client } = build({
      accountTx: jest
        .fn()
        .mockResolvedValueOnce({
          transactions: [
            payment({ value: '10' }),
            // A partial payment: what it delivered, not its Amount.
            payment({ value: '2.5' }),
            payment({ tag: 43 }),
            payment({ currency: 'USD' }),
            payment({ result: 'tecPATH_DRY' }),
            payment({ validated: false }),
            // The treasury's own refund carrying the same tag.
            payment({ from: TREASURY, to: TREASURY }),
          ],
          marker: { ledger: 1, seq: 2 },
        })
        .mockResolvedValueOnce({
          transactions: [
            payment({ value: '0.0000001' }),
            // Closed before the deposit opened (beyond the clock margin): stop.
            payment({ closed: '2026-11-17T07:00:00Z' }),
            payment({ value: '999' }),
          ],
          marker: { ledger: 0, seq: 1 },
        }),
    });
    await expect(ledger.received(deposit())).resolves.toBe(12_500_000n);
    expect(client.accountTx).toHaveBeenCalledTimes(2);
    expect(client.accountTx.mock.calls[1][3]).toEqual({ ledger: 1, seq: 2 });
  });

  it('reads nothing for a deposit without a tag', async () => {
    const { ledger, client } = build();
    await expect(ledger.received(deposit({ depositMemo: null }))).resolves.toBe(
      0n,
    );
    expect(client.accountTx).not.toHaveBeenCalled();
  });

  it('blocks a transfer the treasury or the recipient cannot make, with the reason', async () => {
    const reason = (client: Record<string, unknown>) =>
      build(client).ledger.blocker(TRANSFER);
    await expect(
      reason({ account: jest.fn().mockResolvedValue(null) }),
    ).resolves.toMatch(/does not exist.*fund it with test XRP/);
    await expect(
      reason({ trustLine: jest.fn().mockResolvedValue(null) }),
    ).resolves.toMatch(/treasury.*no trustline.*sandbox:prepare/);
    await expect(
      reason({
        trustLine: jest.fn().mockResolvedValue({
          balance: '24.999999',
          limit: '1000000000',
          freezePeer: false,
        }),
      }),
    ).resolves.toMatch(/holds 24999999 of the test USDC, below 25000000/);
    await expect(
      reason({
        trustLine: jest
          .fn()
          .mockResolvedValueOnce({
            balance: '100',
            limit: '1000000000',
            freezePeer: false,
          })
          .mockResolvedValueOnce(null),
      }),
    ).resolves.toMatch(
      /recipient rN7Td1t4N7xDW8ohKpcvX1WiACRq9R8Ven has no trustline.*only that account can add it/,
    );
    await expect(
      reason({
        account: jest
          .fn()
          .mockResolvedValueOnce({
            sequence: 1,
            balance: 50_000_000n,
            ownerCount: 1,
          })
          .mockResolvedValueOnce({
            sequence: 1,
            balance: 50_000_000n,
            ownerCount: 0,
            requireDestinationTag: true,
          }),
      }),
    ).resolves.toMatch(/requires a destination tag/);
    // The test USDC issuer itself accepts only authorized senders (seen on the
    // testnet: tecNO_PERMISSION), so paying it is refused before signing.
    await expect(
      reason({
        account: jest
          .fn()
          .mockResolvedValueOnce({
            sequence: 1,
            balance: 50_000_000n,
            ownerCount: 1,
          })
          .mockResolvedValueOnce({
            sequence: 1,
            balance: 50_000_000n,
            ownerCount: 0,
            depositAuth: true,
          }),
      }),
    ).resolves.toMatch(/accepts payments only from accounts it authorized/);
    await expect(build().ledger.blocker(TRANSFER)).resolves.toBeNull();
  });

  it('signs a Payment from the next sequence, valid for a bounded window of ledgers', async () => {
    const { ledger, client } = build({
      fee: jest.fn().mockResolvedValue({
        openLedgerFee: 1_000_000n,
        baseFee: 10n,
        currentLedger: 22_000_000,
      }),
    });
    const signed = await ledger.sign(TRANSFER);
    expect(client.account).toHaveBeenCalledWith('xrp', TREASURY, 'current');
    expect(signed.nonce).toBe('9');
    expect(xrplLastLedgerSequence(signed.raw)).toBe(
      22_000_000 + XRPL_TX_VALIDITY_LEDGERS,
    );
    // The fee is capped (5000 drops), and the bytes are exactly the Payment.
    expect(signed).toMatchObject(
      (() => {
        const { blob, hash } = signXrplTransaction(
          {
            TransactionType: 'Payment',
            Flags: 0,
            Sequence: 9,
            LastLedgerSequence: 22_000_000 + XRPL_TX_VALIDITY_LEDGERS,
            Fee: 5_000n,
            Account: TREASURY,
            Destination: MERCHANT,
            Amount: { ...USDC, units: 25_000_000n, decimals: 6 },
          },
          SECRET,
        );
        return { raw: blob, hash };
      })(),
    );
  });

  it('follows a payout to its outcome, rebroadcasting only while it can still validate', async () => {
    const { ledger: signer } = build();
    const signed = await signer.sign(TRANSFER);
    const row = {
      network: 'xrp',
      txHash: signed.hash,
      raw: signed.raw,
    } as never;
    const last = 22_000_000 + XRPL_TX_VALIDITY_LEDGERS;

    const ok = build({
      tx: jest.fn().mockResolvedValue({
        found: true,
        validated: true,
        result: 'tesSUCCESS',
      }),
    });
    await expect(ok.ledger.follow(row)).resolves.toBe('succeeded');
    expect(ok.client.tx).toHaveBeenCalledWith('xrp', signed.hash, {
      minLedger: last - XRPL_TX_VALIDITY_LEDGERS,
      maxLedger: last,
    });
    expect(ok.client.submit).not.toHaveBeenCalled();

    const tec = build({
      tx: jest.fn().mockResolvedValue({
        found: true,
        validated: true,
        result: 'tecPATH_DRY',
      }),
    });
    await expect(tec.ledger.follow(row)).resolves.toBe('failed');

    const expired = build({
      tx: jest.fn().mockResolvedValue({ found: false, searchedAll: true }),
    });
    await expect(expired.ledger.follow(row)).resolves.toBe('failed');
    expect(expired.client.submit).not.toHaveBeenCalled();

    const waiting = build();
    await expect(waiting.ledger.follow(row)).resolves.toBe('pending');
    expect(waiting.client.submit).toHaveBeenCalledWith('xrp', signed.raw);
  });

  it('treats an old or applied blob as no error on broadcast, a malformed one as one', async () => {
    const past = build({
      submit: jest
        .fn()
        .mockResolvedValue({ engineResult: 'tefPAST_SEQ', message: '' }),
    });
    await expect(past.ledger.broadcast('xrp', '12')).resolves.toBeUndefined();
    const malformed = build({
      submit: jest
        .fn()
        .mockResolvedValue({ engineResult: 'temBAD_AMOUNT', message: 'bad' }),
    });
    await expect(malformed.ledger.broadcast('xrp', '12')).rejects.toThrow(
      /temBAD_AMOUNT/,
    );
  });

  it('reports the trustline already in place instead of setting it again', async () => {
    const { ledger, client } = build();
    await expect(ledger.prepareTreasury('xrp')).resolves.toEqual([
      expect.stringMatching(/trustline in place/),
    ]);
    expect(client.submit).not.toHaveBeenCalled();
  });
});
