import {
  LAYERZERO_SCAN_STATUSES,
  type LayerZeroScanMessage,
  type LayerZeroScanResponse,
  pickMessage,
  scanOutcome,
} from '@/usdt0/usdt0-scan';

/**
 * The message LayerZero Scan answered on 2026-10-25 for a real USDT0 transfer
 * from Stellar to Ethereum (`GET /v1/messages/tx/cdad8d8f...`), cut to the
 * fields this service reads.
 */
const DELIVERED_FROM_STELLAR: LayerZeroScanMessage = {
  pathway: { srcEid: 30600, dstEid: 30101 },
  source: {
    status: 'SUCCEEDED',
    tx: {
      txHash:
        'cdad8d8f9eda17db268432ea7a3299a4d8381ebfc2e53d9367dcdc762c388ab8',
    },
  },
  destination: {
    status: 'SUCCEEDED',
    tx: {
      txHash:
        '0xc133786dcb7859d0a5bab083ec351cbf2b1205cd4dea21827ac56ff0f721d164',
    },
  },
  guid: '0xde686e45b4a4ba7553cbe127943bc52035d10e508eaa5b4df5a8dc24c16e2aab',
  status: { name: 'DELIVERED', message: 'Executor transaction confirmed' },
};

const withStatus = (name: string, message?: string): LayerZeroScanMessage => ({
  ...DELIVERED_FROM_STELLAR,
  destination: { status: 'WAITING' },
  status: { name, message },
});

describe('scanOutcome', () => {
  it('reads a delivered message with its destination transaction', () => {
    expect(scanOutcome(DELIVERED_FROM_STELLAR)).toEqual({
      kind: 'delivered',
      scanStatus: 'DELIVERED',
      guid: DELIVERED_FROM_STELLAR.guid,
      destinationTxHash:
        '0xc133786dcb7859d0a5bab083ec351cbf2b1205cd4dea21827ac56ff0f721d164',
    });
  });

  it.each(['INFLIGHT', 'CONFIRMING', 'BLOCKED', 'PAYLOAD_STORED'])(
    'keeps %s travelling: not final, it can still be delivered',
    (name) => {
      expect(scanOutcome(withStatus(name))).toMatchObject({
        kind: 'travelling',
        scanStatus: name,
      });
    },
  );

  it.each([
    'FAILED',
    'APPLICATION_BURNED',
    'APPLICATION_SKIPPED',
    'UNRESOLVABLE_COMMAND',
    'MALFORMED_COMMAND',
  ])('fails on %s, saying so', (name) => {
    const outcome = scanOutcome(withStatus(name, 'gave up'));
    expect(outcome).toMatchObject({ kind: 'failed', scanStatus: name });
    expect(outcome.kind === 'failed' && outcome.reason).toBe(
      `LayerZero reports the message ${name}: gave up`,
    );
  });

  it('maps every status Scan documents', () => {
    for (const name of LAYERZERO_SCAN_STATUSES) {
      expect(['travelling', 'delivered', 'failed']).toContain(
        scanOutcome(withStatus(name)).kind,
      );
    }
  });

  it('never finalizes on a status nobody mapped', () => {
    expect(scanOutcome(withStatus('SOMETHING_NEW'))).toMatchObject({
      kind: 'travelling',
      scanStatus: 'SOMETHING_NEW',
    });
    expect(scanOutcome({})).toMatchObject({
      kind: 'travelling',
      scanStatus: 'UNKNOWN',
      guid: null,
    });
  });
});

describe('pickMessage', () => {
  const other: LayerZeroScanMessage = {
    ...DELIVERED_FROM_STELLAR,
    pathway: { srcEid: 30101, dstEid: 30600 },
    guid: `0x${'11'.repeat(32)}`,
  };
  const response: LayerZeroScanResponse = {
    data: [other, DELIVERED_FROM_STELLAR],
  };

  it('picks the message with the known guid, in any case', () => {
    const upper = `0x${DELIVERED_FROM_STELLAR.guid!.slice(2).toUpperCase()}`;
    expect(pickMessage(response, upper, 30600)).toBe(DELIVERED_FROM_STELLAR);
  });

  it('without a guid, picks the one sent from Stellar', () => {
    expect(pickMessage(response, null, 30600)).toBe(DELIVERED_FROM_STELLAR);
  });

  it('is null when Scan has nothing for it', () => {
    expect(pickMessage(null, null, 30600)).toBeNull();
    expect(pickMessage({ data: [] }, null, 30600)).toBeNull();
    expect(pickMessage({ data: [other] }, null, 30600)).toBeNull();
  });
});
