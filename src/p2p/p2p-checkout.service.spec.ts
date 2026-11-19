import {
  P2pCheckoutBudgetError,
  P2pCheckoutService,
  payerTokenHashOf,
} from '@/p2p/p2p-checkout.service';

const CHARGE_ID = '9b7e2c41-3f5a-4d8e-a1b2-c3d4e5f60718';
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const DTO = {
  rail: 'ar_bank_transfer',
  payer: {
    name: 'Juan Gómez',
    document: '20123456786',
    email: 'juan@example.com',
  },
};

function charge(overrides: Record<string, unknown> = {}) {
  return {
    id: CHARGE_ID,
    consumerId: 'consumer_client',
    tier: 'testnet',
    network: 'base',
    token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    currency: 'ARS',
    fiatAmount: '25000.00',
    recipientAccountId: 'acc',
    recipientAddress: RECIPIENT,
    description: null,
    multiUse: false,
    status: 'open',
    paidCount: 0,
    paidAt: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function setup(
  opts: {
    charge?: Record<string, unknown>;
    liveOnCharge?: number;
    mine?: number;
    recent?: number;
  } = {},
) {
  const inserted: Record<string, unknown>[] = [];
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    p2pOrder: {
      count: jest.fn(({ where }: { where: { clientKey?: string } }) =>
        Promise.resolve(
          where.clientKey ? (opts.mine ?? 0) : (opts.liveOnCharge ?? 0),
        ),
      ),
      findMany: jest.fn(() =>
        Promise.resolve(
          Array.from({ length: opts.recent ?? 0 }, (_, i) => ({
            createdAt: new Date(Date.now() - 60_000 * (10 - i)),
          })),
        ),
      ),
    },
  };
  const prisma = {
    p2pCharge: {
      findUnique: jest.fn(() => Promise.resolve(charge(opts.charge))),
    },
    p2pOrder: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const deployment = { tier: 'testnet', network: 'base', name: 'Base' };
  const quotes = {
    openProtocol: jest.fn().mockResolvedValue({ feeBps: 50 }),
    match: jest.fn().mockResolvedValue({
      account: { address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' },
    }),
  };
  const opener = {
    insert: jest.fn((input: Record<string, unknown>) => {
      inserted.push(input);
      return Promise.resolve({
        id: input.id,
        chargeId: CHARGE_ID,
        status: 'pending',
      });
    }),
    openViaMatcher: jest.fn((_d: unknown, row: unknown) =>
      Promise.resolve(row),
    ),
  };
  const service = new P2pCheckoutService(
    {
      get: () => ({ gatewaySecret: 'topsecret-topsecret-topsecret-topsecret' }),
    } as never,
    prisma as never,
    {
      token: () => ({
        symbol: 'USDC',
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        decimals: 6,
      }),
      matcherAddress: () => '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      timeoutMs: () => 1000,
      find: () => null,
    } as never,
    { requireLive: jest.fn().mockResolvedValue(deployment) } as never,
    quotes as never,
    opener as never,
    { sendBuyerAct: jest.fn() } as never,
    { paymentDetailsOf: jest.fn().mockResolvedValue(null) } as never,
  );
  return { service, inserted, prisma, quotes };
}

describe('P2pCheckoutService', () => {
  it('opens a purchase for the charge’s recipient, owned by its consumer, with a hashed payer token', async () => {
    const { service, inserted, quotes } = setup();
    const created = await service.createOrder(CHARGE_ID, DTO, '203.0.113.7');
    expect(created.payerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const order = inserted[0];
    expect(order).toMatchObject({
      kind: 'CHARGE',
      consumerId: 'consumer_client',
      buyerAddress: RECIPIENT,
      chargeId: CHARGE_ID,
      payerTokenHash: payerTokenHashOf(created.payerToken),
    });
    expect(JSON.stringify(order)).not.toContain(created.payerToken);
    expect(quotes.match).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'BUY',
        fiatUnits: 2_500_000n,
        counterparty: RECIPIENT,
      }),
    );
  });

  it('keeps clients apart by address (an IPv6 caller by its /48), never storing the address', async () => {
    const { service, inserted } = setup();
    await service.createOrder(CHARGE_ID, DTO, '2001:db8:1:1::5');
    await service.createOrder(CHARGE_ID, DTO, '2001:db8:1:2::9');
    await service.createOrder(CHARGE_ID, DTO, '2001:db8:2:1::9');
    const keys = inserted.map((o) => o.clientKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
    expect(String(keys[0])).not.toContain('2001');
  });

  it('refuses a second live order on a single-use charge', async () => {
    const { service } = setup({ liveOnCharge: 1 });
    await expect(
      service.createOrder(CHARGE_ID, DTO, '203.0.113.7'),
    ).rejects.toMatchObject({
      code: 'operation_in_flight',
    });
  });

  it('lets a multi-use charge take orders from several clients, but one live per client', async () => {
    const ok = setup({ charge: { multiUse: true }, liveOnCharge: 3 });
    await expect(
      ok.service.createOrder(CHARGE_ID, DTO, '203.0.113.7'),
    ).resolves.toBeDefined();
    const mine = setup({
      charge: { multiUse: true },
      liveOnCharge: 3,
      mine: 1,
    });
    await expect(
      mine.service.createOrder(CHARGE_ID, DTO, '203.0.113.7'),
    ).rejects.toMatchObject({
      code: 'operation_in_flight',
    });
  });

  it('answers 429 with a retry time once the charge’s creation budget is spent', async () => {
    const { service } = setup({ charge: { multiUse: true }, recent: 5 });
    const err = await service
      .createOrder(CHARGE_ID, DTO, '203.0.113.7')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(P2pCheckoutBudgetError);
    expect((err as P2pCheckoutBudgetError).retryAfterSeconds).toBeGreaterThan(
      0,
    );
  });

  it('refuses a paid, cancelled or expired charge', async () => {
    for (const c of [
      { status: 'paid' },
      { status: 'cancelled' },
      { expiresAt: new Date(Date.now() - 1) },
    ]) {
      const { service } = setup({ charge: c });
      await expect(
        service.createOrder(CHARGE_ID, DTO, '203.0.113.7'),
      ).rejects.toMatchObject({
        code: 'request_closed',
      });
    }
  });

  it('reads an order only with its payer token', async () => {
    const { service, prisma } = setup();
    await expect(
      service.getOrder('3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10', undefined),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(prisma.p2pOrder.findFirst).not.toHaveBeenCalled();
    await expect(
      service.getOrder('3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10', 'wrong'),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(prisma.p2pOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          payerTokenHash: payerTokenHashOf('wrong'),
          kind: 'CHARGE',
        }),
      }),
    );
  });
});
