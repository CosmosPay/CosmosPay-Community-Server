import { nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import type { Usdt0Transfer } from '@generated/prisma/client';
import type { PrismaService } from '@/prisma/prisma.service';
import type { SorobanRpcClient } from '@/stellar/soroban-rpc.client';
import type { LayerZeroScanClient } from '@/usdt0/layerzero-scan.client';
import type { LayerZeroScanMessage } from '@/usdt0/usdt0-scan';
import { Usdt0TransferTracker } from '@/usdt0/usdt0-transfer-tracker.service';
import { USDT0_STATUS_REFRESH_MS } from '@/usdt0/usdt0.constants';

const TX_HASH = 'cd'.repeat(32);
const GUID = `0x${'ab'.repeat(32)}`;
const DEST_TX = `0x${'ef'.repeat(32)}`;

function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map(
        (key) =>
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol(key),
            val: fields[key],
          }),
      ),
  );
}
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const SEND_RETURN = xdr.ScVal.scvVec([
  struct({
    fee: struct({ native_fee: i128(5n), zro_fee: i128(0n) }),
    guid: xdr.ScVal.scvBytes(Buffer.from(GUID.slice(2), 'hex')),
    nonce: nativeToScVal(9n, { type: 'u64' }),
  }),
  struct({ amount_received_ld: i128(10n), amount_sent_ld: i128(10n) }),
]);

const LANDED = {
  status: rpc.Api.GetTransactionStatus.SUCCESS,
  returnValue: SEND_RETURN,
};
const NOT_FOUND = { status: rpc.Api.GetTransactionStatus.NOT_FOUND };

function message(name: string, extra: Partial<LayerZeroScanMessage> = {}) {
  return {
    data: [
      {
        pathway: { srcEid: 30600, dstEid: 30101 },
        guid: GUID,
        status: { name, message: `${name} message` },
        destination: { status: 'WAITING' },
        ...extra,
      },
    ],
  };
}

function row(overrides: Partial<Usdt0Transfer> = {}): Usdt0Transfer {
  return {
    id: 'u0_1',
    consumerId: 'consumer_1',
    network: 'public',
    status: 'PENDING',
    source: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    to: 'eth',
    eid: 30101,
    receives: 'USDT',
    recipient: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    amount: '10',
    amountSent: '10',
    amountReceived: '10',
    nativeFee: '3.5',
    nativeFeeLimit: '4.2',
    networkFee: '1.45',
    xdr: 'AAAA',
    uri: 'web+stellar:tx?xdr=AAAA',
    txHash: TX_HASH,
    guid: null,
    destinationTxHash: null,
    scanStatus: null,
    failureReason: null,
    idempotencyKey: null,
    expiresAt: new Date(Date.now() + 300_000),
    lastCheckedAt: null,
    submittedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function setup(initial: Usdt0Transfer) {
  const stored: Usdt0Transfer = { ...initial };
  const matches = (where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      const current = (stored as Record<string, unknown>)[key];
      if (value instanceof Date || current instanceof Date) {
        return (
          (current as Date | null)?.getTime() ===
          (value as Date | null)?.getTime()
        );
      }
      return current === value;
    });
  const prisma = {
    usdt0Transfer: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!matches(where)) return { count: 0 };
        Object.assign(stored, data);
        return { count: 1 };
      }),
      findUnique: jest.fn(async () => ({ ...stored })),
    },
  };
  const rpcClient = { getTransaction: jest.fn() };
  const scan = {
    byGuid: jest.fn().mockResolvedValue(null),
    byTransaction: jest.fn().mockResolvedValue(null),
  };
  const tracker = new Usdt0TransferTracker(
    prisma as unknown as PrismaService,
    rpcClient as unknown as SorobanRpcClient,
    scan as unknown as LayerZeroScanClient,
  );
  jest.spyOn(tracker as any, 'pause').mockResolvedValue(undefined);
  return { tracker, stored, prisma, rpc: rpcClient, scan };
}

describe('Usdt0TransferTracker.refresh', () => {
  it('moves a PENDING transfer the wallet broadcast itself to SUBMITTED, with the guid, then asks Scan by guid', async () => {
    const t = setup(row());
    t.rpc.getTransaction.mockResolvedValue(LANDED);
    t.scan.byGuid.mockResolvedValue(message('INFLIGHT'));

    const fresh = await t.tracker.refresh(t.stored);

    expect(t.rpc.getTransaction).toHaveBeenCalledWith(TX_HASH);
    expect(t.scan.byGuid).toHaveBeenCalledWith(GUID);
    expect(t.scan.byTransaction).not.toHaveBeenCalled();
    expect(fresh).toMatchObject({
      status: 'SUBMITTED',
      guid: GUID,
      scanStatus: 'INFLIGHT',
    });
    expect(fresh.submittedAt).toBeInstanceOf(Date);
  });

  it('marks DELIVERED with the destination transaction', async () => {
    const t = setup(row({ status: 'SUBMITTED', guid: GUID }));
    t.scan.byGuid.mockResolvedValue(
      message('DELIVERED', {
        destination: { status: 'SUCCEEDED', tx: { txHash: DEST_TX } },
      }),
    );
    const fresh = await t.tracker.refresh(t.stored);
    // The guid is known: the ledger is not asked again.
    expect(t.rpc.getTransaction).not.toHaveBeenCalled();
    expect(fresh).toMatchObject({
      status: 'DELIVERED',
      destinationTxHash: DEST_TX,
      scanStatus: 'DELIVERED',
    });
  });

  it('marks FAILED when LayerZero gives up, saying so', async () => {
    const t = setup(row({ status: 'SUBMITTED', guid: GUID }));
    t.scan.byGuid.mockResolvedValue(message('APPLICATION_BURNED'));
    const fresh = await t.tracker.refresh(t.stored);
    expect(fresh).toMatchObject({
      status: 'FAILED',
      scanStatus: 'APPLICATION_BURNED',
      failureReason:
        'LayerZero reports the message APPLICATION_BURNED: APPLICATION_BURNED message',
    });
  });

  it('keeps a stuck message SUBMITTED, recording why', async () => {
    const t = setup(row({ status: 'SUBMITTED', guid: GUID }));
    t.scan.byGuid.mockResolvedValue(message('PAYLOAD_STORED'));
    const fresh = await t.tracker.refresh(t.stored);
    expect(fresh).toMatchObject({
      status: 'SUBMITTED',
      scanStatus: 'PAYLOAD_STORED',
    });
  });

  it('without a guid, recovers it from the ledger and still asks Scan by transaction when the receipt is unreadable', async () => {
    const t = setup(row({ status: 'SUBMITTED' }));
    t.rpc.getTransaction.mockResolvedValue({
      ...LANDED,
      returnValue: xdr.ScVal.scvVoid(),
    });
    t.scan.byTransaction.mockResolvedValue(message('CONFIRMING'));
    const fresh = await t.tracker.refresh(t.stored);
    expect(t.scan.byTransaction).toHaveBeenCalledWith(TX_HASH);
    // Scan's guid fills the one the receipt could not give.
    expect(fresh).toMatchObject({
      status: 'SUBMITTED',
      guid: GUID,
      scanStatus: 'CONFIRMING',
    });
  });

  it('expires a PENDING transfer the ledger never saw once its time bounds closed', async () => {
    const t = setup(row({ expiresAt: new Date(Date.now() - 120_000) }));
    t.rpc.getTransaction.mockResolvedValue(NOT_FOUND);
    expect((await t.tracker.refresh(t.stored)).status).toBe('EXPIRED');
  });

  it('leaves a PENDING transfer alone while it can still land', async () => {
    const t = setup(row());
    t.rpc.getTransaction.mockResolvedValue(NOT_FOUND);
    const fresh = await t.tracker.refresh(t.stored);
    expect(fresh.status).toBe('PENDING');
    expect(t.scan.byGuid).not.toHaveBeenCalled();
    expect(t.scan.byTransaction).not.toHaveBeenCalled();
  });

  it('asks upstream at most once per window', async () => {
    const now = new Date();
    const t = setup(
      row({
        lastCheckedAt: new Date(
          now.getTime() - USDT0_STATUS_REFRESH_MS + 1_000,
        ),
      }),
    );
    await t.tracker.refresh(t.stored, now);
    expect(t.rpc.getTransaction).not.toHaveBeenCalled();
    expect(t.prisma.usdt0Transfer.updateMany).not.toHaveBeenCalled();
  });

  it('lets one of two racing reads ask upstream', async () => {
    const t = setup(row());
    t.rpc.getTransaction.mockResolvedValue(NOT_FOUND);
    const stale = { ...t.stored };
    await t.tracker.refresh(t.stored);
    // The second read still holds the row with no lastCheckedAt: its claim loses.
    await t.tracker.refresh(stale);
    expect(t.rpc.getTransaction).toHaveBeenCalledTimes(1);
  });

  it('answers from the row when an upstream fails', async () => {
    const t = setup(row({ status: 'SUBMITTED', guid: GUID }));
    t.scan.byGuid.mockRejectedValue(new Error('scan down'));
    await expect(t.tracker.refresh(t.stored)).resolves.toMatchObject({
      status: 'SUBMITTED',
    });
  });

  it('never refreshes a final transfer', async () => {
    for (const status of ['DELIVERED', 'FAILED', 'EXPIRED'] as const) {
      const t = setup(row({ status }));
      await t.tracker.refresh(t.stored);
      expect(t.prisma.usdt0Transfer.updateMany).not.toHaveBeenCalled();
    }
  });
});

describe('Usdt0TransferTracker.awaitLedger', () => {
  it('waits for the ledger, then records the guid', async () => {
    const t = setup(row());
    t.rpc.getTransaction
      .mockResolvedValueOnce(NOT_FOUND)
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce(LANDED);
    const fresh = await t.tracker.awaitLedger(t.stored);
    expect(t.rpc.getTransaction).toHaveBeenCalledTimes(3);
    expect(fresh).toMatchObject({ status: 'SUBMITTED', guid: GUID });
  });

  it('gives up waiting with SUBMITTED and no guid: the next read settles it', async () => {
    const t = setup(row());
    t.rpc.getTransaction.mockResolvedValue(NOT_FOUND);
    const fresh = await t.tracker.awaitLedger(t.stored);
    expect(t.rpc.getTransaction).toHaveBeenCalledTimes(15);
    expect(fresh).toMatchObject({ status: 'SUBMITTED', guid: null });
  });
});
