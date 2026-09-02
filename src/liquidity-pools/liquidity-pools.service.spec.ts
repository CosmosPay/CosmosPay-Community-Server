import { Account, Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { HttpStatus } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApiError, ApiErrorCode } from '../common/errors/api-error';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { toStroops } from '../swaps/swap-math';
import { LiquidityPoolsService } from './liquidity-pools.service';
import { SettlementObserverService } from '../observer/settlement-observer.service';
import { WebhookTerminalEmitter } from '../webhooks/webhook-terminal-emitter.service';
import { WEBHOOK_EVENT } from '../webhooks/webhook-events';

jest.mock('qrcode', () => ({
  __esModule: true,
  default: {
    toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,qq'),
  },
}));

const TX_HASH = 'ab'.repeat(32);
const POOL_ID = 'dd'.repeat(32);
const SOURCE = Keypair.random().publicKey();
const USDC_ISSUER = Keypair.random().publicKey();
const FEE_WALLET = Keypair.random().publicKey();

const consumer: GatewayConsumer = {
  username: 'cosmos_u1',
  credentialId: 'cred_1',
  environment: 'dev',
  role: 'user',
  permissions: ['liquidity:write'],
  organizationId: 'org_1',
  plan: 'pro',
  planSwapFeeBps: 50,
};

function horizonReject(codes: { transaction?: string; operations?: string[] }) {
  const err: any = new Error('Horizon rejected the transaction');
  err.response = { data: { extras: { result_codes: codes } } };
  return err;
}

function matchesWhere(row: any, where: any): boolean {
  if (!where) return true;
  if (where.id && where.id !== row.id) return false;
  if (where.kind && where.kind !== row.kind) return false;
  if (where.consumerId && where.consumerId !== row.consumerId) return false;
  if (where.source && where.source !== row.source) return false;
  if (where.poolId && where.poolId !== row.poolId) return false;
  if (where.network && where.network !== row.network) return false;
  if (where.sharesReceived === null && row.sharesReceived != null) return false;
  if (where.status !== undefined) {
    if (typeof where.status === 'string') {
      if (row.status !== where.status) return false;
    } else if (where.status.in && !where.status.in.includes(row.status)) {
      return false;
    }
  }
  if (
    where.expiresAt !== undefined &&
    !matchesExpiresAt(row, where.expiresAt)
  ) {
    return false;
  }
  // The in-flight guard uses `OR: [{ expiresAt: null }, { expiresAt: { gt } }]`.
  if (where.OR && !where.OR.some((clause: any) => matchesWhere(row, clause))) {
    return false;
  }
  if (where.consumer?.apisixUsername) {
    if (row.consumer?.apisixUsername !== where.consumer.apisixUsername) {
      return false;
    }
  }
  return true;
}

function matchesExpiresAt(row: any, filter: any): boolean {
  if (filter === null) return row.expiresAt == null;
  if (filter?.gt) return row.expiresAt != null && row.expiresAt > filter.gt;
  return true;
}

/** Terminal/created webhook emissions of one type, in order. */
function terminalEmits(events: EventEmitter2, type: string) {
  return (events.emit as unknown as jest.Mock).mock.calls.filter(
    ([name, payload]) => name === WEBHOOK_EVENT && payload.type === type,
  );
}

function createPrisma(seed: any[] = []) {
  const rows = seed.map((r) => ({ ...r }));
  const applySelect = (row: any, select?: any) => {
    if (!select) return { ...row };
    const out: any = {};
    for (const k of Object.keys(select)) if (select[k]) out[k] = row[k];
    return out;
  };
  const prisma: any = {
    rows,
    // findAllOperations batches [findMany, count]; the mocks already return
    // real promises, so awaiting them together is enough.
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    consumer: {
      // Distinct local ids per API key, so a test can withdraw a position that
      // was deposited under a different organization.
      upsert: jest.fn(async ({ where, create }: any) => ({
        ...create,
        id: where.apisixUsername === consumer.username ? 'c1' : 'c2',
        apisixUsername: where.apisixUsername,
      })),
    },
    liquidityPoolOperation: {
      findMany: jest.fn(async ({ where, select, include }: any) =>
        rows
          .filter((r) => matchesWhere(r, where))
          .map((r) => {
            const copy = applySelect(r, select);
            if (include?.consumer) copy.consumer = r.consumer;
            return copy;
          }),
      ),
      findFirst: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) => matchesWhere(r, where));
        return row ? { ...row } : null;
      }),
      count: jest.fn(
        async ({ where }: any) =>
          rows.filter((r) => matchesWhere(r, where)).length,
      ),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        return { ...row };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.consumerId_idempotencyKey) {
          const { consumerId, idempotencyKey } =
            where.consumerId_idempotencyKey;
          const row = rows.find(
            (r) =>
              r.consumerId === consumerId &&
              r.idempotencyKey === idempotencyKey,
          );
          return row ? { ...row } : null;
        }
        const row = rows.find((r) => r.id === where.id);
        return row ? { ...row } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const matched = rows.filter((r) => matchesWhere(r, where));
        for (const row of matched) {
          const next = { ...data };
          if (next.settlementEpoch?.increment != null) {
            row.settlementEpoch =
              (row.settlementEpoch ?? 0) + next.settlementEpoch.increment;
            delete next.settlementEpoch;
          }
          Object.assign(row, next);
        }
        return { count: matched.length };
      }),
      // Simulates both unique indexes on the table:
      // @@unique([consumerId, idempotencyKey]) and @@unique([network, txHash]).
      create: jest.fn(async ({ data }: any) => {
        if (data.idempotencyKey) {
          const clash = rows.find(
            (r) =>
              r.consumerId === data.consumerId &&
              r.idempotencyKey === data.idempotencyKey,
          );
          if (clash) {
            const err: any = new Error('Unique constraint failed');
            err.code = 'P2002';
            err.meta = { target: ['consumerId', 'idempotencyKey'] };
            throw err;
          }
        }
        const hashClash = rows.find(
          (r) => r.network === data.network && r.txHash === data.txHash,
        );
        if (hashClash) {
          const err: any = new Error('Unique constraint failed');
          err.code = 'P2002';
          err.meta = { target: ['network', 'txHash'] };
          throw err;
        }
        const created = {
          id: `op_${rows.length + 1}`,
          idempotencyKey: null,
          sharesReceived: null,
          settledAmountA: null,
          settledAmountB: null,
          settlementEpoch: 0,
          consumer: { apisixUsername: consumer.username },
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.push(created);
        return { ...created };
      }),
    },
    webhookEmittedEvent: uniqueEmittedEvents(),
  };
  return prisma;
}

/** Simulates the unique index on webhook_emitted_event.dedupKey (P2002). */
function uniqueEmittedEvents() {
  const keys = new Set<string>();
  const tails = new Map<string, Promise<unknown>>();
  return {
    create: jest.fn(async ({ data }: any) => {
      const prev = tails.get(data.dedupKey) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      tails.set(
        data.dedupKey,
        prev.then(
          () => gate,
          () => gate,
        ),
      );
      try {
        await prev.catch(() => undefined);
        if (keys.has(data.dedupKey)) {
          const err: any = new Error(
            'Unique constraint failed on the fields: (`dedupKey`)',
          );
          err.code = 'P2002';
          err.meta = { target: ['dedupKey'] };
          throw err;
        }
        keys.add(data.dedupKey);
        return { id: `wee_${keys.size}`, createdAt: new Date(), ...data };
      } finally {
        release();
      }
    }),
  };
}

function stellarConfig() {
  return {
    network: 'testnet',
    baseFee: '100',
    timeoutSeconds: 300,
    swap: {
      feeWallet: FEE_WALLET,
      feeBps: 50,
      slippageBps: 50,
      maxSlippageBps: 500,
    },
    horizon: { public: 'https://h', testnet: 'https://h' },
  };
}

function mockHorizonAccount(balances: any[]) {
  const account: any = new Account(SOURCE, '1');
  account.balances = balances;
  account.subentry_count = 1;
  return account;
}

const DEFAULT_BALANCES = [
  { asset_type: 'native', balance: '10000' },
  {
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: USDC_ISSUER,
    balance: '5000',
  },
  {
    asset_type: 'liquidity_pool_shares',
    liquidity_pool_id: POOL_ID,
    balance: '100',
  },
];

function makeStellar(
  overrides: {
    submitTransaction?: jest.Mock;
    effectsCall?: jest.Mock;
    txCall?: jest.Mock;
    loadAccount?: jest.Mock;
    fetchPool?: jest.Mock;
  } = {},
) {
  const effectsCall =
    overrides.effectsCall ??
    jest.fn().mockResolvedValue({
      records: [
        {
          type: 'liquidity_pool_deposited',
          shares_received: '100',
          reserves_deposited: [
            { asset: 'native', amount: '1000' },
            { asset: `USDC:${USDC_ISSUER}`, amount: '100' },
          ],
        },
      ],
    });
  const submitTransaction =
    overrides.submitTransaction ??
    jest.fn().mockResolvedValue({ hash: TX_HASH });
  const txCall =
    overrides.txCall ?? jest.fn().mockResolvedValue({ successful: true });
  const loadAccount =
    overrides.loadAccount ??
    // Fresh Account each call so the sequence stays at Horizon's view (N), not
    // N+k after a prior TransactionBuilder mutation — needed for the
    // txHash-collision tests, which depend on two builds being byte-identical.
    jest
      .fn()
      .mockImplementation(async () => mockHorizonAccount(DEFAULT_BALANCES));
  const fetchPool =
    overrides.fetchPool ??
    jest.fn().mockResolvedValue({
      id: POOL_ID,
      paging_token: '1',
      fee_bp: 30,
      total_trustlines: '2',
      total_shares: '100',
      reserves: [
        { asset: 'native', amount: '2000' },
        { asset: `USDC:${USDC_ISSUER}`, amount: '200' },
      ],
    });

  return {
    passphrase: jest.fn().mockReturnValue('Test SDF Network ; September 2015'),
    server: jest.fn().mockReturnValue({
      submitTransaction,
      effects: () => ({ forTransaction: () => ({ call: effectsCall }) }),
      transactions: () => ({ transaction: () => ({ call: txCall }) }),
      loadAccount,
      liquidityPools: () => ({
        liquidityPoolId: () => ({ call: fetchPool }),
      }),
    }),
    submitTransaction,
    effectsCall,
    txCall,
    loadAccount,
    fetchPool,
  };
}

function depositRow(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'lp_1',
    consumerId: 'c1',
    kind: 'DEPOSIT',
    status: 'PENDING',
    network: 'testnet',
    source: SOURCE,
    poolId: POOL_ID,
    assetA: 'native',
    assetAIssuer: null,
    assetB: 'USDC',
    assetBIssuer: USDC_ISSUER,
    amountA: '1000',
    amountB: '100',
    shares: null,
    sharesReceived: null,
    settledAmountA: null,
    settledAmountB: null,
    minPrice: '9.9',
    maxPrice: '10.1',
    slippageBps: 50,
    idempotencyKey: null,
    feeBps: 0,
    feeAmountA: '0',
    feeAmountB: '0',
    feeWallet: null,
    xdr: 'AAAA',
    uri: 'web+stellar:tx?xdr=AAAA',
    txHash: TX_HASH,
    settlementEpoch: 0,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    consumer: { apisixUsername: consumer.username },
    ...overrides,
  };
}

describe('LiquidityPoolsService — commission engine', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let stellar: ReturnType<typeof makeStellar>;
  let events: EventEmitter2;
  let service: LiquidityPoolsService;

  beforeEach(() => {
    prisma = createPrisma();
    stellar = makeStellar();
    events = { emit: jest.fn() } as any;
    const config = { get: () => stellarConfig() } as any;
    const webhooks = new WebhookTerminalEmitter(prisma, events);
    service = new LiquidityPoolsService(
      config,
      prisma,
      webhooks,
      stellar as any,
    );
  });

  describe('costBasis', () => {
    it('counts a settled deposit toward remaining shares and cost', async () => {
      prisma.rows.push(
        depositRow({
          status: 'SUCCEEDED',
          sharesReceived: '100',
          settledAmountA: '1000',
          settledAmountB: '100',
        }),
      );
      const basis = await (service as any).costBasis(
        SOURCE,
        POOL_ID,
        'testnet',
      );
      expect(basis.depositedShares).toBe(toStroops('100'));
      expect(basis.remainingShares).toBe(toStroops('100'));
      expect(basis.costA).toBe(toStroops('1000'));
      expect(basis.costB).toBe(toStroops('100'));
    });

    it('does not count FAILED deposits — a degraded row would lose the basis', async () => {
      prisma.rows.push(
        depositRow({
          status: 'FAILED',
          sharesReceived: '100',
          settledAmountA: '1000',
          settledAmountB: '100',
        }),
      );
      const basis = await (service as any).costBasis(
        SOURCE,
        POOL_ID,
        'testnet',
      );
      expect(basis.remainingShares).toBe(0n);
      expect(basis.costA).toBe(0n);
    });

    it('subtracts a succeeded withdraw from remaining shares (partial)', async () => {
      prisma.rows.push(
        depositRow({
          status: 'SUCCEEDED',
          sharesReceived: '100',
          settledAmountA: '1000',
          settledAmountB: '100',
        }),
        depositRow({
          id: 'lp_w1',
          kind: 'WITHDRAW',
          status: 'SUCCEEDED',
          shares: '40',
          sharesReceived: null,
          amountA: '396',
          amountB: '39.6',
        }),
      );
      const basis = await (service as any).costBasis(
        SOURCE,
        POOL_ID,
        'testnet',
      );
      expect(basis.depositedShares).toBe(toStroops('100'));
      expect(basis.remainingShares).toBe(toStroops('60'));
    });
  });

  describe('captureDepositBasis', () => {
    it('writes sharesReceived and settled amounts for a SUCCEEDED deposit', async () => {
      const row = depositRow({ status: 'SUCCEEDED' });
      prisma.rows.push(row);
      await service.captureDepositBasis(row);
      expect(row.sharesReceived).toBe('100');
      expect(row.settledAmountA).toBe('1000');
      expect(row.settledAmountB).toBe('100');
    });

    it('does not overwrite an already-captured cost basis', async () => {
      const row = depositRow({
        status: 'SUCCEEDED',
        sharesReceived: '100',
        settledAmountA: '1000',
        settledAmountB: '100',
      });
      prisma.rows.push(row);
      stellar.effectsCall.mockResolvedValue({
        records: [
          {
            type: 'liquidity_pool_deposited',
            shares_received: '999',
            reserves_deposited: [
              { asset: 'native', amount: '1' },
              { asset: `USDC:${USDC_ISSUER}`, amount: '1' },
            ],
          },
        ],
      });
      await service.captureDepositBasis(row);
      expect(row.sharesReceived).toBe('100');
      expect(row.settledAmountA).toBe('1000');
      expect(stellar.effectsCall).not.toHaveBeenCalled();
    });

    it('does not write a cost basis onto a FAILED row', async () => {
      const row = depositRow({ status: 'FAILED' });
      prisma.rows.push(row);
      await service.captureDepositBasis(row);
      expect(row.sharesReceived).toBeNull();
      expect(stellar.effectsCall).not.toHaveBeenCalled();
    });
  });

  describe('withdraw', () => {
    function seedSucceededDeposit() {
      prisma.rows.push(
        depositRow({
          status: 'SUCCEEDED',
          sharesReceived: '100',
          settledAmountA: '1000',
          settledAmountB: '100',
        }),
      );
    }

    it('charges commission on a withdraw with a gain', async () => {
      seedSucceededDeposit();
      const op = await service.withdraw(consumer, {
        source: SOURCE,
        poolId: POOL_ID,
        shares: '100',
        slippageBps: 0,
      });
      // Doubled reserves, full exit, 50 bps of (2000-1000) / (200-100).
      expect(op.feeAmountA).toBe('5');
      expect(op.feeAmountB).toBe('0.5');
      expect(op.feeWallet).toBe(FEE_WALLET);
      expect(op.feeBps).toBe(50);
    });

    it('charges nothing on a withdraw with a loss', async () => {
      seedSucceededDeposit();
      stellar.fetchPool.mockResolvedValue({
        id: POOL_ID,
        paging_token: '1',
        fee_bp: 30,
        total_trustlines: '2',
        total_shares: '100',
        reserves: [
          { asset: 'native', amount: '500' },
          { asset: `USDC:${USDC_ISSUER}`, amount: '50' },
        ],
      });
      const op = await service.withdraw(consumer, {
        source: SOURCE,
        poolId: POOL_ID,
        shares: '100',
        slippageBps: 0,
      });
      expect(op.feeAmountA).toBe('0');
      expect(op.feeAmountB).toBe('0');
      expect(op.feeWallet).toBeNull();
    });

    it('charges only the covered shares on a partial withdraw', async () => {
      seedSucceededDeposit();
      const op = await service.withdraw(consumer, {
        source: SOURCE,
        poolId: POOL_ID,
        shares: '40',
        slippageBps: 0,
      });
      expect(op.feeAmountA).toBe('2');
      expect(op.feeAmountB).toBe('0.2');
    });
  });
});

describe('LiquidityPoolsService.submit vs observer (issue #32 race)', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let stellar: ReturnType<typeof makeStellar>;
  let events: EventEmitter2;
  let service: LiquidityPoolsService;
  let observer: SettlementObserverService;

  beforeEach(() => {
    prisma = createPrisma();
    stellar = makeStellar();
    events = { emit: jest.fn() } as any;
    const config = {
      get: (key?: string) =>
        key === 'observer'
          ? { enabled: false, intervalMs: 15_000, batchSize: 50 }
          : stellarConfig(),
    } as any;
    const webhooks = new WebhookTerminalEmitter(prisma, events);
    service = new LiquidityPoolsService(
      config,
      prisma,
      webhooks,
      stellar as any,
    );
    observer = new SettlementObserverService(
      config,
      prisma,
      stellar as any,
      service,
      {} as any,
    );
    jest
      .spyOn(TransactionBuilder, 'fromXDR')
      .mockReturnValue({ hash: () => Buffer.from(TX_HASH, 'hex') } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not degrade a liquidated operation to FAILED when Horizon returns result codes after the observer settled it', async () => {
    // The case that used to fail: observer writes SUCCEEDED + cost basis
    // during submit's Horizon round-trip; submit then treated tx_already_included
    // as a rejection and unconditionally UPDATE'd the row to FAILED, dropping
    // the deposit from cost-basis aggregation (status !== SUCCEEDED).
    const row = depositRow({ status: 'PENDING' });
    prisma.rows.push(row);

    stellar.submitTransaction.mockImplementation(async () => {
      stellar.txCall.mockResolvedValue({ successful: true });
      await (observer as any).reconcileLiquidity(50);
      throw horizonReject({ transaction: 'tx_already_included' });
    });

    const outcome = await service.submit(consumer, row.id, 'signed-xdr');

    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.submitted).toBe(true);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.sharesReceived).toBe('100');
    expect(row.settledAmountA).toBe('1000');
    expect(row.settledAmountB).toBe('100');

    const basis = await (service as any).costBasis(SOURCE, POOL_ID, 'testnet');
    expect(basis.remainingShares).toBe(toStroops('100'));
    expect(basis.costA).toBe(toStroops('1000'));

    const succeeded = (events.emit as unknown as jest.Mock).mock.calls.filter(
      ([name, payload]) =>
        name === WEBHOOK_EVENT && payload.type === 'LIQUIDITY_SUCCEEDED',
    );
    expect(succeeded).toHaveLength(1);
  });

  it('observer FAILED must not overwrite a row submit already marked SUCCEEDED', async () => {
    const row = depositRow({
      status: 'SUCCEEDED',
      sharesReceived: '100',
      settledAmountA: '1000',
      settledAmountB: '100',
    });
    prisma.rows.push(row);

    // Stale read: observer loaded this row while it was still SUBMITTED.
    prisma.liquidityPoolOperation.findMany.mockResolvedValueOnce([
      {
        ...row,
        status: 'SUBMITTED',
        sharesReceived: null,
        settledAmountA: null,
        settledAmountB: null,
        consumer: { apisixUsername: consumer.username },
      },
    ]);
    stellar.txCall.mockResolvedValue({ successful: false });

    await (observer as any).reconcileLiquidity(50);

    expect(row.status).toBe('SUCCEEDED');
    expect(row.sharesReceived).toBe('100');
    expect(row.settledAmountA).toBe('1000');
  });

  it('finalizeFailed is a no-op on SUCCEEDED and never emits LIQUIDITY_FAILED', async () => {
    const row = depositRow({
      status: 'SUCCEEDED',
      sharesReceived: '100',
      settledAmountA: '1000',
      settledAmountB: '100',
    });
    prisma.rows.push(row);

    const result = await service.finalizeFailed(row.id, consumer.username);

    expect(result.applied).toBe(false);
    expect(result.operation.status).toBe('SUCCEEDED');
    expect(row.status).toBe('SUCCEEDED');
    expect(row.sharesReceived).toBe('100');
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('finalizeExpired cannot degrade a liquidated operation', async () => {
    const row = depositRow({
      status: 'SUCCEEDED',
      sharesReceived: '50',
      settledAmountA: '500',
      settledAmountB: '50',
    });
    prisma.rows.push(row);

    const result = await service.finalizeExpired(row.id);
    expect(result.applied).toBe(false);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.sharesReceived).toBe('50');
  });

  it('observer and submit in parallel emit LIQUIDITY_SUCCEEDED once (used to emit twice)', async () => {
    const row = depositRow({ status: 'PENDING' });
    prisma.rows.push(row);
    stellar.txCall.mockResolvedValue({ successful: true });
    stellar.submitTransaction.mockResolvedValue({ hash: TX_HASH });

    await Promise.all([
      service.submit(consumer, row.id, 'signed-xdr'),
      (observer as any).reconcileLiquidity(50),
    ]);

    expect(row.status).toBe('SUCCEEDED');
    const succeeded = (events.emit as unknown as jest.Mock).mock.calls.filter(
      ([name, payload]) =>
        name === WEBHOOK_EVENT && payload.type === 'LIQUIDITY_SUCCEEDED',
    );
    expect(succeeded).toHaveLength(1);
  });
});

// ── Idempotency + cost-basis scope (back-ported from the swaps hardening) ────

const depositDto = {
  source: SOURCE,
  assetBCode: 'USDC',
  assetBIssuer: USDC_ISSUER,
  maxAmountA: '1000',
  slippageBps: 0,
};

const withdrawDto = {
  source: SOURCE,
  poolId: POOL_ID,
  shares: '100',
  slippageBps: 0,
};

/** A second organization's API key for the same Stellar account. */
const otherConsumer: GatewayConsumer = {
  ...consumer,
  username: 'cosmos_u2',
  credentialId: 'cred_2',
  organizationId: 'org_2',
};

describe('LiquidityPoolsService idempotency (issue #17, back-ported)', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let stellar: ReturnType<typeof makeStellar>;
  let events: EventEmitter2;
  let service: LiquidityPoolsService;

  beforeEach(() => {
    prisma = createPrisma();
    stellar = makeStellar();
    events = { emit: jest.fn() } as any;
    const config = { get: () => stellarConfig() } as any;
    const webhooks = new WebhookTerminalEmitter(prisma, events);
    service = new LiquidityPoolsService(
      config,
      prisma,
      webhooks,
      stellar as any,
    );
    // Frozen clock: two builds of the same request are byte-identical, so the
    // second one collides on the unique (network, txHash) exactly as in prod.
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('two deposits with the same Idempotency-Key insert one row and emit one LIQUIDITY_CREATED', async () => {
    const first = await service.deposit(consumer, depositDto, 'dep-key-1');
    const second = await service.deposit(consumer, depositDto, 'dep-key-1');

    expect(prisma.liquidityPoolOperation.create).toHaveBeenCalledTimes(1);
    expect(second.id).toBe(first.id);
    expect(second.txHash).toBe(first.txHash);
    expect(prisma.rows).toHaveLength(1);
    expect(terminalEmits(events, 'LIQUIDITY_CREATED')).toHaveLength(1);
    // The replay is a pure read — no Horizon round-trip, no rebuild.
    expect(stellar.loadAccount).toHaveBeenCalledTimes(1);
  });

  it('deduplicates a withdraw on the same key too', async () => {
    const first = await service.withdraw(consumer, withdrawDto, 'wd-key-1');
    const second = await service.withdraw(consumer, withdrawDto, 'wd-key-1');

    expect(second.id).toBe(first.id);
    expect(prisma.rows).toHaveLength(1);
    expect(terminalEmits(events, 'LIQUIDITY_CREATED')).toHaveLength(1);
  });

  it('accepts the key in the body when no header is sent', async () => {
    const dto = { ...depositDto, idempotencyKey: 'body-key' };
    const first = await service.deposit(consumer, dto);
    const second = await service.deposit(consumer, dto);

    expect(second.id).toBe(first.id);
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].idempotencyKey).toBe('body-key');
  });

  it('lets the Idempotency-Key header win over the body field', async () => {
    await service.deposit(
      consumer,
      { ...depositDto, idempotencyKey: 'body-key' },
      'header-key',
    );
    expect(prisma.rows[0].idempotencyKey).toBe('header-key');
  });

  it('recovers the winner of a same-key race instead of surfacing P2002', async () => {
    const winner = depositRow({
      id: 'op_winner',
      idempotencyKey: 'race-key',
      txHash: 'cd'.repeat(32),
    });
    let keyLookups = 0;
    prisma.liquidityPoolOperation.findUnique.mockImplementation(
      async ({ where }: any) => {
        if (where.consumerId_idempotencyKey) {
          keyLookups += 1;
          // First lookup misses (the race window); once create fails, the
          // winner's row is visible.
          return keyLookups === 1 ? null : { ...winner };
        }
        return null;
      },
    );
    prisma.liquidityPoolOperation.create.mockRejectedValue({
      code: 'P2002',
      meta: { target: ['consumerId', 'idempotencyKey'] },
    });

    const result = await service.deposit(consumer, depositDto, 'race-key');

    expect(result.id).toBe('op_winner');
    expect(result.txHash).toBe(winner.txHash);
    // The insert never happened, so the loser mints no second CREATED event.
    expect(terminalEmits(events, 'LIQUIDITY_CREATED')).toHaveLength(0);
  });

  it('recovers via the key even when Postgres reports the (network, txHash) target', async () => {
    // Same-key concurrent creates rebuild the same XDR, so both unique indexes
    // can fire; Postgres reports only one of them, arbitrarily. The caller must
    // still get the existing operation, not a 409.
    const winner = depositRow({
      id: 'op_winner',
      idempotencyKey: 'same-key',
      txHash: 'ef'.repeat(32),
    });
    let keyLookups = 0;
    prisma.liquidityPoolOperation.findUnique.mockImplementation(
      async ({ where }: any) => {
        if (where.consumerId_idempotencyKey) {
          keyLookups += 1;
          return keyLookups === 1 ? null : { ...winner };
        }
        return null;
      },
    );
    prisma.liquidityPoolOperation.create.mockRejectedValue({
      code: 'P2002',
      meta: { target: ['network', 'txHash'] },
    });

    const result = await service.deposit(consumer, depositDto, 'same-key');

    expect(result.id).toBe('op_winner');
    expect(result.txHash).toBe(winner.txHash);
  });

  it('rejects a keyless byte-identical rebuild with 409 idempotency_conflict', async () => {
    // The old bare `create` accepted this: a double-submitted deposit left two
    // PENDING rows sharing one on-chain transaction.
    await service.deposit(consumer, depositDto);
    expect(prisma.rows).toHaveLength(1);

    const err = await service.deposit(consumer, depositDto).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).getStatus()).toBe(HttpStatus.CONFLICT);
    expect((err as ApiError).code).toBe(ApiErrorCode.IdempotencyConflict);
    expect(prisma.rows).toHaveLength(1);
    expect(terminalEmits(events, 'LIQUIDITY_CREATED')).toHaveLength(1);
  });
});

describe('LiquidityPoolsService.withdraw in-flight guard', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let stellar: ReturnType<typeof makeStellar>;
  let events: EventEmitter2;
  let service: LiquidityPoolsService;

  beforeEach(() => {
    prisma = createPrisma();
    stellar = makeStellar();
    events = { emit: jest.fn() } as any;
    const config = { get: () => stellarConfig() } as any;
    const webhooks = new WebhookTerminalEmitter(prisma, events);
    service = new LiquidityPoolsService(
      config,
      prisma,
      webhooks,
      stellar as any,
    );
  });

  function inflightWithdraw(overrides: Record<string, unknown> = {}) {
    return depositRow({
      id: 'op_inflight',
      kind: 'WITHDRAW',
      status: 'PENDING',
      shares: '50',
      ...overrides,
    });
  }

  it('rejects a second withdraw while one is in flight for the same position', async () => {
    // Both would read the same cost basis and each charge commission on the
    // whole unrealized gain.
    prisma.rows.push(inflightWithdraw());

    const err = await service.withdraw(consumer, withdrawDto).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).getStatus()).toBe(HttpStatus.CONFLICT);
    expect((err as ApiError).code).toBe(ApiErrorCode.OperationInFlight);
  });

  it('discloses nothing about the blocking operation', async () => {
    prisma.rows.push(inflightWithdraw());

    const err = await service.withdraw(consumer, withdrawDto).catch((e) => e);

    expect((err as ApiError).code).toBe(ApiErrorCode.OperationInFlight);
    // Not its id, not its owner.
    expect((err as ApiError).message).not.toContain('op_inflight');
  });

  it("does not let one organization block a stranger's account", async () => {
    // The guard used to be account-wide, so anyone holding `liquidity:write`
    // could post a dust withdrawal naming a stranger's public Stellar address
    // and freeze that account's withdrawals for a full transaction-timeout
    // window — repeatable indefinitely. `source` is public and nothing requires
    // the caller to control it, so this needed no access to the victim at all.
    prisma.rows.push(inflightWithdraw({ consumerId: 'c2' }));

    const op = await service.withdraw(consumer, withdrawDto);

    expect(op.kind).toBe('WITHDRAW');
  });

  it('still blocks a second key of the same user', async () => {
    // Scoping to the consumer does not weaken the guard: a Consumer row is keyed
    // on the APISIX username (cosmos_<userId>), not on the credential, so every
    // API key one user holds resolves to the same consumer.
    prisma.rows.push(inflightWithdraw({ consumerId: 'c1' }));

    const err = await service
      .withdraw({ ...consumer, credentialId: 'a-different-key' }, withdrawDto)
      .catch((e) => e);

    expect((err as ApiError).code).toBe(ApiErrorCode.OperationInFlight);
  });

  it('ignores an expired in-flight withdraw', async () => {
    prisma.rows.push(
      inflightWithdraw({ expiresAt: new Date(Date.now() - 60_000) }),
    );

    const op = await service.withdraw(consumer, withdrawDto);
    expect(op.kind).toBe('WITHDRAW');
  });

  it('ignores a settled withdraw and an in-flight deposit', async () => {
    prisma.rows.push(
      inflightWithdraw({ id: 'op_done', status: 'SUCCEEDED' }),
      depositRow({ id: 'op_dep', status: 'PENDING' }),
    );

    const op = await service.withdraw(consumer, withdrawDto);
    expect(op.kind).toBe('WITHDRAW');
  });
});

describe('LiquidityPoolsService cost basis is platform-wide', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let stellar: ReturnType<typeof makeStellar>;
  let events: EventEmitter2;
  let service: LiquidityPoolsService;

  beforeEach(() => {
    prisma = createPrisma();
    stellar = makeStellar();
    events = { emit: jest.fn() } as any;
    const config = { get: () => stellarConfig() } as any;
    const webhooks = new WebhookTerminalEmitter(prisma, events);
    service = new LiquidityPoolsService(
      config,
      prisma,
      webhooks,
      stellar as any,
    );
  });

  it('charges commission on a withdraw made under a different organization', async () => {
    // The evasion this closes: deposit under org A, register a second free org,
    // withdraw the same Stellar account's shares under org B. The basis lookup
    // was scoped by consumerId, found nothing, and taxed the whole gain at zero.
    prisma.rows.push(
      depositRow({
        consumerId: 'c1',
        status: 'SUCCEEDED',
        sharesReceived: '100',
        settledAmountA: '1000',
        settledAmountB: '100',
      }),
    );

    const op = await service.withdraw(otherConsumer, withdrawDto);

    expect(op.feeAmountA).toBe('5');
    expect(op.feeAmountB).toBe('0.5');
    expect(op.feeWallet).toBe(FEE_WALLET);
  });

  it('does not credit basis earned on another network', async () => {
    // Testnet is free; without the network in the key, a testnet deposit would
    // mint cost basis against a public-network withdrawal.
    prisma.rows.push(
      depositRow({
        network: 'public',
        status: 'SUCCEEDED',
        sharesReceived: '100',
        settledAmountA: '1000',
        settledAmountB: '100',
      }),
    );

    const basis = await (service as any).costBasis(SOURCE, POOL_ID, 'testnet');
    expect(basis.depositedShares).toBe(0n);
    expect(basis.costA).toBe(0n);
  });

  it('still scopes the operations listing to the calling consumer', async () => {
    // The widened lookup changes fee arithmetic only: another tenant's rows
    // must stay out of every response.
    prisma.rows.push(
      depositRow({
        consumerId: 'c1',
        status: 'SUCCEEDED',
        sharesReceived: '100',
        settledAmountA: '1000',
        settledAmountB: '100',
      }),
    );

    const mine = await service.findAllOperations(consumer, {
      take: 20,
      skip: 0,
    });
    const theirs = await service.findAllOperations(otherConsumer, {
      take: 20,
      skip: 0,
    });

    expect(mine.data).toHaveLength(1);
    expect(mine.total).toBe(1);
    expect(theirs.data).toHaveLength(0);
    expect(theirs.total).toBe(0);
  });
});

describe('SettlementObserverService duplicate txHash (liquidity pools)', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let stellar: ReturnType<typeof makeStellar>;
  let events: EventEmitter2;
  let service: LiquidityPoolsService;
  let observer: SettlementObserverService;

  beforeEach(() => {
    prisma = createPrisma();
    stellar = makeStellar();
    events = { emit: jest.fn() } as any;
    const config = {
      get: (key?: string) =>
        key === 'observer'
          ? { enabled: false, intervalMs: 15_000, batchSize: 50 }
          : stellarConfig(),
    } as any;
    const webhooks = new WebhookTerminalEmitter(prisma, events);
    service = new LiquidityPoolsService(
      config,
      prisma,
      webhooks,
      stellar as any,
    );
    observer = new SettlementObserverService(
      config,
      prisma,
      stellar as any,
      service,
      {} as any,
    );
  });

  it('two PENDING operations sharing one txHash emit a single LIQUIDITY_SUCCEEDED', async () => {
    const a = depositRow({ id: 'lp_a', status: 'PENDING', txHash: TX_HASH });
    const b = depositRow({ id: 'lp_b', status: 'PENDING', txHash: TX_HASH });
    prisma.rows.push(a, b);
    stellar.txCall.mockResolvedValue({ successful: true });

    await (observer as any).reconcileLiquidity(50);

    expect(a.status).toBe('SUCCEEDED');
    expect(b.status).toBe('SUCCEEDED');
    expect(terminalEmits(events, 'LIQUIDITY_SUCCEEDED')).toHaveLength(1);
    // One Horizon lookup for the shared hash, not one per row.
    expect(stellar.txCall).toHaveBeenCalledTimes(1);
  });

  it('captures the cost basis once for one on-chain deposit', async () => {
    // Capturing it on every duplicate would count the same shares twice and
    // start taxing shares acquired outside Cosmos Pay.
    const a = depositRow({ id: 'lp_a', status: 'PENDING', txHash: TX_HASH });
    const b = depositRow({ id: 'lp_b', status: 'PENDING', txHash: TX_HASH });
    prisma.rows.push(a, b);
    stellar.txCall.mockResolvedValue({ successful: true });

    await (observer as any).reconcileLiquidity(50);

    expect(a.sharesReceived).toBe('100');
    expect(b.sharesReceived).toBeNull();
    const basis = await (service as any).costBasis(SOURCE, POOL_ID, 'testnet');
    expect(basis.depositedShares).toBe(toStroops('100'));
  });

  it('emits a single LIQUIDITY_FAILED for a shared failing hash', async () => {
    const a = depositRow({ id: 'lp_a', status: 'SUBMITTED', txHash: TX_HASH });
    const b = depositRow({ id: 'lp_b', status: 'SUBMITTED', txHash: TX_HASH });
    prisma.rows.push(a, b);
    stellar.txCall.mockResolvedValue({ successful: false });

    await (observer as any).reconcileLiquidity(50);

    expect(a.status).toBe('FAILED');
    expect(b.status).toBe('FAILED');
    expect(terminalEmits(events, 'LIQUIDITY_FAILED')).toHaveLength(1);
    expect(stellar.txCall).toHaveBeenCalledTimes(1);
  });
});

/**
 * The commission rule is shared with swaps via `resolvePlanCommissionBps`.
 * Before that extraction the two modules had separate private copies and they
 * had drifted: swaps failed closed when the gateway stopped forwarding the plan
 * rate, while liquidity pools silently repriced every organization at
 * STELLAR_SWAP_FEE_BPS. These pin the pools side of the shared rule.
 */
describe('LiquidityPoolsService platform commission fail-closed', () => {
  /** The gateway did not forward the plan rate. */
  const noPlanRate: GatewayConsumer = { ...consumer, planSwapFeeBps: null };

  function make(nodeEnv: string, swapOverrides: Record<string, unknown> = {}) {
    const prisma = createPrisma();
    const stellar = makeStellar();
    const events = { emit: jest.fn() } as any;
    const base = stellarConfig();
    const config = {
      get: (key?: string) =>
        key === 'nodeEnv'
          ? nodeEnv
          : key === 'apisix'
            ? { swapFeeBpsHeader: 'x-plan-swap-fee-bps' }
            : { ...base, swap: { ...base.swap, ...swapOverrides } },
    } as any;
    const service = new LiquidityPoolsService(
      config,
      prisma,
      new WebhookTerminalEmitter(prisma, events),
      stellar as any,
    );
    return { service, prisma };
  }

  it('refuses to price a withdraw in production when the header is missing', async () => {
    const { service } = make('production');

    const err = await service.withdraw(noPlanRate, withdrawDto).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect((err as ApiError).code).toBe(ApiErrorCode.Misconfigured);
    // The operator has to be told *which* header the gateway stopped sending.
    expect((err as ApiError).message).toMatch(/x-plan-swap-fee-bps/i);
  });

  it('never silently reprices at STELLAR_SWAP_FEE_BPS in production', async () => {
    // The dangerous outcome is not an error — it is a successful withdraw
    // billed at the platform default instead of the organization's plan rate.
    // This is exactly what the pools copy used to do.
    const { service, prisma } = make('production', { feeBps: 999 });

    await expect(service.withdraw(noPlanRate, withdrawDto)).rejects.toThrow(
      ApiError,
    );
    expect(prisma.rows).toHaveLength(0);
  });

  it('still falls back to the configured default outside production', async () => {
    const { service } = make('development', { feeBps: 50 });

    const op = await service.withdraw(noPlanRate, withdrawDto);

    expect(op.kind).toBe('WITHDRAW');
  });
});
