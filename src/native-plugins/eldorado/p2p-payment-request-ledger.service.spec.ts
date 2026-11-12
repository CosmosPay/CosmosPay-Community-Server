import { Logger } from '@nestjs/common';
import { P2pPaymentRequestLedger } from '@/native-plugins/eldorado/p2p-payment-request-ledger.service';
import { PaymentRequestRails } from '@/payment-request-rails/payment-request-rails';

type Row = Record<string, unknown>;

/** The request table with the filters the ledger writes: equality, null and `in`. */
function table(rows: Row[]) {
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([field, want]) =>
      want && typeof want === 'object' && 'in' in want
        ? (want as { in: unknown[] }).in.includes(row[field])
        : row[field] === want,
    );
  return {
    rows,
    findUnique: jest.fn(({ where }: { where: Row }) => {
      const row = rows.find((r) => r.id === where.id);
      return Promise.resolve(row ? { ...row } : null);
    }),
    updateMany: jest.fn(({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return Promise.resolve({ count: hit.length });
    }),
  };
}

function setup(over: Row = {}) {
  const row: Row = {
    id: 'creq1',
    consumerId: 'c_seller',
    network: 'public',
    status: 'open',
    currency: 'ARS',
    amount: '15000',
    chainId: 137,
    token: 'USDT',
    tokenAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    tokenDecimals: 6,
    address: '0x52908400098527886E0F7030069857D2E4169EE7',
    expiresAt: new Date(Date.now() + 60_000),
    paidAt: null,
    ...over,
  };
  const prisma = { p2pPaymentRequest: table([row]) };
  const rails = new PaymentRequestRails();
  const ledger = new P2pPaymentRequestLedger(prisma as never, rails);
  ledger.onModuleInit();
  return { ledger, rails, row, prisma };
}

describe('P2pPaymentRequestLedger', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('registers itself and reads a request with its owner and what it reads as', async () => {
    const { rails, ledger } = setup({ expiresAt: new Date(Date.now() - 1) });

    expect(rails.ledger()).toBe(ledger);
    await expect(ledger.find('creq1')).resolves.toMatchObject({
      id: 'creq1',
      ownerId: 'c_seller',
      status: 'expired',
      address: '0x52908400098527886E0F7030069857D2E4169EE7',
    });
    await expect(ledger.find('cmissing')).resolves.toBeNull();
    await expect(ledger.find('../etc')).resolves.toBeNull();
  });

  it('moves an open, expired or cancelled request to processing, never a paid one', async () => {
    for (const [over, moves] of [
      [{}, true],
      [{ expiresAt: new Date(Date.now() - 1) }, true],
      [{ status: 'cancelled' }, true],
      [{ status: 'paid', paidAt: new Date() }, false],
      [{ status: 'processing' }, false],
    ] as const) {
      const { ledger, row } = setup(over);
      await expect(ledger.markProcessing('creq1', new Date())).resolves.toBe(
        moves,
      );
      if (moves) expect(row.status).toBe('processing');
    }
  });

  it('pays once by transfer, and the first completion wins', async () => {
    const { ledger, row } = setup({ status: 'processing' });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const at = new Date('2026-11-12T12:00:00.000Z');

    await expect(
      ledger.markPaid('creq1', {
        method: 'transfer',
        amount: '9.97',
        txHash: '0xabc',
        at,
      }),
    ).resolves.toBe(true);
    await expect(
      ledger.markPaid('creq1', {
        method: 'p2p',
        amount: '9.5',
        txHash: null,
        at: new Date(),
      }),
    ).resolves.toBe(false);

    expect(row).toMatchObject({
      status: 'paid',
      paidAt: at,
      paidAmount: '9.97',
      paidTxHash: '0xabc',
      paidMethod: 'transfer',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('was already paid'),
    );
  });
});
