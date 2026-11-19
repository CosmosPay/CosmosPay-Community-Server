import { encodeAbiParameters, encodeEventTopics, type Abi } from 'viem';
import { compileContract } from '@/evm/in-process-evm.harness-spec';
import type { EvmLog } from '@/evm/evm-rpc.client';
import { P2pIndexerService, sortLogs } from '@/p2p/p2p-indexer.service';
import type { P2pDeployment } from '@/p2p/p2p-networks.service';
import { orderRef } from '@/p2p/p2p-order-ref';

jest.setTimeout(60_000);

const MATCHER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const MERCHANT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const BUYER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const ZERO = '0x0000000000000000000000000000000000000000';
const ORDER_ID = '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10';
const T0 = 1_800_000_000;

const D: P2pDeployment = {
  tier: 'testnet',
  network: 'base',
  name: 'Base',
  chainId: 84532,
  contract: CONTRACT,
  deployBlock: 100n,
  rpcUrl: 'http://node',
  tokens: [],
  confirmations: 2,
  logBlockRange: 10,
};

let abi: Abi;
beforeAll(() => {
  abi = compileContract('P2PMarket.sol', 'P2PMarket').abi;
});

function log(
  eventName: string,
  indexed: Record<string, unknown>,
  types: { type: string }[],
  values: unknown[],
  block = 150,
  index = 0,
): EvmLog {
  return {
    address: CONTRACT,
    topics: encodeEventTopics({
      abi,
      eventName,
      args: indexed,
    }) as string[],
    data: encodeAbiParameters(types, values),
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${String(block).padStart(64, '0')}`,
    logIndex: `0x${index.toString(16)}`,
  };
}

const opened = (
  overrides: { opener?: string; amount?: bigint; buyer?: string } = {},
) =>
  log(
    'OrderOpened',
    { id: 7n, opener: overrides.opener ?? MATCHER, ref: orderRef(ORDER_ID) },
    [
      { type: 'address' },
      { type: 'address' },
      { type: 'address' },
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'bool' },
    ],
    [
      MERCHANT,
      overrides.buyer ?? BUYER,
      TOKEN,
      overrides.amount ?? 100_000_000n,
      0n,
      true,
    ],
    150,
    0,
  );

const byId = (
  name: string,
  values: unknown[],
  types: { type: string }[],
  block: number,
) => log(name, { id: 7n }, types, values, block);

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    ref: orderRef(ORDER_ID),
    consumerId: 'consumer_client',
    tier: 'testnet',
    kind: 'BUY',
    network: 'base',
    contract: CONTRACT,
    token: TOKEN,
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    merchantAccountId: 'acc_m',
    merchantConsumerId: 'consumer_merchant',
    merchantAddress: MERCHANT,
    merchantDisplayName: 'Pampa',
    merchantPaymentMethodId: 'pm',
    currency: 'ARS',
    rail: 'ar_bank_transfer',
    price: '1000',
    fiatAmount: '100000.00',
    tokenAmount: '100000000',
    netAmount: '99500000',
    protocolFeeBps: 50,
    integratorFeeBps: 0,
    integratorAddress: null,
    bond: '0',
    acceptWindow: 0,
    paymentWindow: 1800,
    settleWindow: 0,
    openerAddress: MATCHER,
    sellerAddress: MERCHANT,
    buyerAddress: BUYER,
    onchainId: null as string | null,
    status: 'pending',
    acceptDeadline: null as Date | null,
    paymentDeadline: null as Date | null,
    paidAt: null as Date | null,
    endedAt: null,
    chainStatus: null,
    chargeId: null,
    payoutBatchId: null,
    ...overrides,
  };
}

function setup(row: ReturnType<typeof order>, logs: EvmLog[], head = 200n) {
  const orders = [row];
  const accounts = [
    { id: 'acc_m', completedOrders: 0, cancelledOrders: 0, disputesLost: 0 },
  ];
  const matches = (
    r: Record<string, unknown>,
    where: Record<string, unknown>,
  ) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'in' in v) {
        return (v as { in: unknown[] }).in.includes(r[k]);
      }
      return r[k] === v;
    });
  const cursor: { lastBlock?: bigint } = {};
  const prisma = {
    p2pChainCursor: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          cursor.lastBlock === undefined
            ? null
            : { lastBlock: cursor.lastBlock },
        ),
      ),
      upsert: jest.fn(({ update }: { update: { lastBlock: bigint } }) => {
        cursor.lastBlock = update.lastBlock;
        return Promise.resolve({});
      }),
    },
    p2pOrder: {
      findUnique: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        if (where.ref)
          return Promise.resolve(
            orders.find((o) => o.ref === where.ref) ?? null,
          );
        if (where.id)
          return Promise.resolve(orders.find((o) => o.id === where.id) ?? null);
        const key = where.tier_network_contract_onchainId as Record<
          string,
          unknown
        >;
        return Promise.resolve(
          orders.find((o) => o.onchainId === key.onchainId) ?? null,
        );
      }),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hit = orders.filter((o) => matches(o, where));
          for (const o of hit) Object.assign(o, data);
          return Promise.resolve({ count: hit.length });
        },
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    p2pAccount: {
      updateMany: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const a = accounts[0] as Record<string, unknown>;
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in v) {
            a[k] = (a[k] as number) + (v as { increment: number }).increment;
          } else a[k] = v;
        }
        return Promise.resolve({ count: 1 });
      }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const chain = {
    blockNumber: jest.fn().mockResolvedValue(head),
    blockTimestamp: jest.fn((_d: unknown, block: bigint) =>
      Promise.resolve(T0 + Number(block)),
    ),
    getLogs: jest.fn((_d: unknown, _t: unknown, from: bigint, to: bigint) =>
      Promise.resolve(
        logs.filter(
          (l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to,
        ),
      ),
    ),
  };
  const reader = { getOrder: jest.fn() };
  const webhooks = { order: jest.fn().mockResolvedValue(undefined) };
  const charges = { onOrderCompleted: jest.fn() };
  const payouts = { onOrderEnded: jest.fn() };
  const indexer = new P2pIndexerService(
    { get: () => ({ enabled: false, indexerIntervalMs: 1000 }) } as never,
    prisma as never,
    { anyConfigured: () => true, timeoutMs: () => 1000 } as never,
    chain as never,
    reader as never,
    webhooks as never,
    charges as never,
    payouts as never,
    {} as never,
  );
  return {
    indexer,
    orders,
    accounts,
    chain,
    webhooks,
    charges,
    payouts,
    cursor,
    reader,
  };
}

describe('P2pIndexerService', () => {
  it('opens our order from its OrderOpened, then follows it to completed', async () => {
    const paid = byId('OrderPaid', [MATCHER], [{ type: 'address' }], 160);
    const released = byId(
      'OrderReleased',
      [MERCHANT, 99_500_000n, 500_000n, 0n],
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      170,
    );
    const { indexer, orders, webhooks, charges, accounts } = setup(order(), [
      released,
      opened(),
      paid,
    ]);
    await indexer.indexDeployment(D);
    const row = orders[0];
    expect(row).toMatchObject({
      onchainId: '7',
      status: 'completed',
      paidAt: new Date((T0 + 160) * 1000),
      endedAt: new Date((T0 + 170) * 1000),
      paymentDeadline: new Date((T0 + 150 + 1800) * 1000),
    });
    expect(webhooks.order.mock.calls.map((c) => c[0])).toEqual([
      'P2P_ORDER_CREATED',
      'P2P_ORDER_PAID',
      'P2P_ORDER_COMPLETED',
    ]);
    expect(charges.onOrderCompleted).toHaveBeenCalledTimes(1);
    expect(accounts[0].completedOrders).toBe(1);
  });

  it('ignores a copy of our ref under another opener, or with other terms', async () => {
    for (const log of [
      opened({ opener: BUYER }),
      opened({ amount: 1n }),
      opened({ buyer: MERCHANT }),
    ]) {
      const { indexer, orders, webhooks } = setup(order(), [log]);
      await indexer.indexDeployment(D);
      expect(orders[0].status).toBe('pending');
      expect(orders[0].onchainId).toBeNull();
      expect(webhooks.order).not.toHaveBeenCalled();
    }
  });

  it('reads a sale back from the contract and ignores one opened with other windows', async () => {
    const sale = order({
      kind: 'SELL',
      sellerAddress: BUYER,
      buyerAddress: MERCHANT,
      openerAddress: BUYER,
      bond: '10000000',
      acceptWindow: 300,
      settleWindow: 21600,
    });
    const saleLog = log(
      'OrderOpened',
      { id: 7n, opener: BUYER, ref: orderRef(ORDER_ID) },
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint128' },
        { type: 'uint128' },
        { type: 'bool' },
      ],
      [BUYER, MERCHANT, TOKEN, 100_000_000n, 10_000_000n, false],
      150,
    );
    const onchain = {
      paymentWindow: 1800,
      settleWindow: 21600,
      integratorFeeBps: 0,
      integrator: ZERO,
      fromBalance: false,
      feeBps: 50,
      acceptDeadline: T0 + 150 + 300,
    };
    const good = setup({ ...sale }, [saleLog]);
    good.reader.getOrder.mockResolvedValue(onchain);
    await good.indexer.indexDeployment(D);
    expect(good.orders[0]).toMatchObject({
      status: 'awaiting_acceptance',
      onchainId: '7',
      acceptDeadline: new Date((T0 + 150 + 300) * 1000),
    });

    const bad = setup({ ...sale }, [saleLog]);
    bad.reader.getOrder.mockResolvedValue({ ...onchain, settleWindow: 3600 });
    await bad.indexer.indexDeployment(D);
    expect(bad.orders[0].status).toBe('pending');
  });

  it('reads a cancel past the payment deadline as expired, and not against a purchase merchant', async () => {
    const cancelled = byId(
      'OrderCancelled',
      [MATCHER],
      [{ type: 'address' }],
      190,
    );
    const row = order({
      status: 'awaiting_payment',
      onchainId: '7',
      paymentDeadline: new Date((T0 + 180) * 1000),
    });
    const { indexer, orders, webhooks, accounts } = setup(row, [cancelled]);
    await indexer.indexDeployment(D);
    expect(orders[0].status).toBe('expired');
    expect(webhooks.order.mock.calls[0][0]).toBe('P2P_ORDER_EXPIRED');
    expect(accounts[0].cancelledOrders).toBe(0);
  });

  it('counts a sale the merchant never accepted against it', async () => {
    const cancelled = byId(
      'OrderCancelled',
      [MATCHER],
      [{ type: 'address' }],
      190,
    );
    const row = order({
      kind: 'SELL',
      status: 'awaiting_acceptance',
      onchainId: '7',
      acceptDeadline: new Date((T0 + 180) * 1000),
      sellerAddress: BUYER,
      buyerAddress: MERCHANT,
    });
    const { indexer, orders, accounts } = setup(row, [cancelled]);
    await indexer.indexDeployment(D);
    expect(orders[0].status).toBe('expired');
    expect(accounts[0].cancelledOrders).toBe(1);
  });

  it('never moves an order back: a log read again changes nothing', async () => {
    const paid = byId('OrderPaid', [MATCHER], [{ type: 'address' }], 160);
    const row = order({ status: 'completed', onchainId: '7' });
    const { indexer, orders, webhooks } = setup(row, [paid]);
    await indexer.indexDeployment(D);
    expect(orders[0].status).toBe('completed');
    expect(webhooks.order).not.toHaveBeenCalled();
  });

  it('reads only confirmed blocks, in bounded ranges, re-reading the last window', async () => {
    const { indexer, chain, cursor } = setup(order(), [], 160n);
    await indexer.indexDeployment(D);
    // Confirmed head 158, ranges of 10 from the deploy block.
    expect(chain.getLogs.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      [100n, 109n],
      [110n, 119n],
      [120n, 129n],
      [130n, 139n],
      [140n, 149n],
      [150n, 158n],
    ]);
    expect(cursor.lastBlock).toBe(158n);
    chain.getLogs.mockClear();
    chain.blockNumber.mockResolvedValue(170n);
    await indexer.indexDeployment(D);
    // From the cursor minus the re-read window (32 blocks), up to 168.
    expect(chain.getLogs.mock.calls[0][2]).toBe(127n);
    expect(chain.getLogs.mock.calls.at(-1)?.[3]).toBe(168n);
  });

  it('sorts logs by block, then index', () => {
    const a = { blockNumber: '0x2', logIndex: '0x0' } as EvmLog;
    const b = { blockNumber: '0x1', logIndex: '0x5' } as EvmLog;
    const c = { blockNumber: '0x1', logIndex: '0x1' } as EvmLog;
    expect(sortLogs([a, b, c])).toEqual([c, b, a]);
  });
});
