import { P2pChargesService } from '@/p2p/p2p-charges.service';

const ID = '9b7e2c41-3f5a-4d8e-a1b2-c3d4e5f60718';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    tier: 'testnet',
    network: 'base',
    token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    currency: 'ARS',
    fiatAmount: '25000.00',
    recipientAccountId: 'acc',
    recipientAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    payeeName: 'Tienda Salta',
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

function setup() {
  const prisma = {
    p2pCharge: {
      findFirst: jest.fn().mockResolvedValue(row()),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(row(data)),
      ),
    },
  };
  const service = new P2pChargesService(
    {
      get: () => ({ checkoutUrl: 'https://pay.example/p2p' }),
    } as never,
    prisma as never,
    { resolveId: jest.fn().mockResolvedValue('consumer_1') } as never,
    {
      ownedByRef: jest.fn().mockResolvedValue({
        id: 'acc',
        address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      }),
    } as never,
    {
      tierFor: () => 'testnet',
      find: () => ({
        tokens: [
          {
            symbol: 'USDC',
            address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          },
        ],
      }),
      token: () => ({
        symbol: 'USDC',
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        decimals: 6,
      }),
    } as never,
    {
      requireLive: jest
        .fn()
        .mockResolvedValue({ network: 'base', tier: 'testnet' }),
    } as never,
    {} as never,
  );
  return { service, prisma };
}

const CONSUMER = { username: 'cosmos_u1', environment: 'dev' } as never;

describe('P2pChargesService', () => {
  it('answers the payer page and a QR of it, and the payee name the creator chose', async () => {
    const { service, prisma } = setup();
    const charge = await service.create(CONSUMER, {
      currency: 'ARS',
      fiatAmount: '25000',
      network: 'base',
      token: 'USDC',
      recipient: 'acc',
      payeeName: '  Tienda Salta ',
    });
    expect(prisma.p2pCharge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payeeName: 'Tienda Salta',
          fiatAmount: '25000.00',
        }),
      }),
    );
    expect(charge.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(charge).toMatchObject({
      url: `https://pay.example/p2p/${charge.id}`,
      payeeName: 'Tienda Salta',
      tokenSymbol: 'USDC',
      status: 'open',
    });
    expect(charge.qr).toMatch(/^data:image\/png;base64,/);
    expect(charge).not.toHaveProperty('consumerId');
  });

  it('reads an open charge past its expiry as expired', async () => {
    const { service, prisma } = setup();
    prisma.p2pCharge.findFirst.mockResolvedValue(
      row({ expiresAt: new Date(Date.now() - 1) }),
    );
    expect((await service.get(CONSUMER, ID)).status).toBe('expired');
  });

  it('refuses an expiry in the past or more than 30 days away', async () => {
    const { service } = setup();
    for (const expiresAt of [
      new Date(Date.now() - 1000).toISOString(),
      new Date(Date.now() + 31 * 24 * 3600 * 1000).toISOString(),
    ]) {
      await expect(
        service.create(CONSUMER, {
          currency: 'ARS',
          fiatAmount: '25000',
          network: 'base',
          token: 'USDC',
          recipient: 'acc',
          payeeName: 'Tienda Salta',
          expiresAt,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }
  });
});
