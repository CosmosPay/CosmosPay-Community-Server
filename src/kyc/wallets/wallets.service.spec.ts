import { WALLET_PUBLIC_SELECT, WalletsService } from './wallets.service';

const CONSUMER = { username: 'cosmos_u1', role: 'user' } as any;

function walletRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bw_local_1',
    consumerId: 'c1',
    receiverId: 'rcv_1',
    blindpayId: 'bw_000000000000',
    name: 'Primary wallet',
    network: 'stellar',
    address: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
    isAccountAbstraction: false,
    raw: { signature: '0xdeadbeef', is_account_abstraction: false },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Projects a full row through a Prisma `select`, exactly as the database would.
 *
 * The fake must NOT pre-strip `raw`: doing that made the assertions below
 * tautologies — they proved the test helper dropped the field, while the
 * service under test was never involved. Storing the full row and projecting by
 * the `select` the service actually passes is what makes "the provider blob
 * never leaves PostgreSQL" a real guarantee here.
 */
function applySelect(
  row: Record<string, unknown>,
  select?: Record<string, boolean>,
): Record<string, unknown> {
  if (!select) return row;
  return Object.fromEntries(
    Object.keys(select)
      .filter((k) => select[k])
      .map((k) => [k, row[k]]),
  );
}

function makeService() {
  const prisma: any = {
    blindpayBlockchainWallet: {
      // Prisma's real behaviour: store the full row, return only what `select`
      // asks for. A fake that pre-strips `raw` makes the assertions below
      // tautologies — they would prove the helper dropped it, not the service.
      findMany: jest.fn(({ select }: any) =>
        Promise.resolve([applySelect(walletRow(), select)]),
      ),
      count: jest.fn().mockResolvedValue(1),
      findFirst: jest.fn(({ select }: any) =>
        Promise.resolve(applySelect(walletRow(), select)),
      ),
      delete: jest.fn(),
      upsert: jest.fn(({ select }: any) =>
        Promise.resolve(applySelect(walletRow(), select)),
      ),
    },
  };
  const blindpay = {
    post: jest.fn(),
    get: jest.fn(),
    delete: jest.fn(),
    instancePath: jest.fn((p: string) => `/instances/in_test${p}`),
  };
  const consumers = { resolve: jest.fn().mockResolvedValue({ id: 'c1' }) };
  const receivers = {
    findReceiverOrThrow: jest
      .fn()
      .mockResolvedValue({ id: 'rcv_1', blindpayId: 're_1', disabled: false }),
    assertEnabled: jest.fn(),
  };
  const service = new WalletsService(
    prisma,
    blindpay as any,
    consumers as any,
    receivers as any,
  );
  return { service, prisma, blindpay };
}

describe('WalletsService.findAll', () => {
  it('selects only the documented fields (no provider blob)', async () => {
    const { service, prisma } = makeService();
    prisma.blindpayBlockchainWallet.count.mockResolvedValue(1);

    const result = await service.findAll(CONSUMER, 'rcv_1', {
      take: 100,
      skip: 0,
    });

    expect(WALLET_PUBLIC_SELECT).not.toHaveProperty('raw');
    expect(prisma.blindpayBlockchainWallet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: WALLET_PUBLIC_SELECT }),
    );
    expect(result.data[0]).not.toHaveProperty('raw');
  });

  it('reports the row count, not the page length', async () => {
    const { service, prisma } = makeService();
    prisma.blindpayBlockchainWallet.findMany.mockResolvedValue([
      walletRow(),
      walletRow({ id: 'bw_local_2' }),
    ]);
    prisma.blindpayBlockchainWallet.count.mockResolvedValue(9);

    const result = await service.findAll(CONSUMER, 'rcv_1', {
      take: 100,
      skip: 0,
    });

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(9);
    expect(prisma.blindpayBlockchainWallet.count).toHaveBeenCalledWith({
      where: { receiverId: 'rcv_1' },
    });
  });
});

describe('WalletsService.create', () => {
  it('mirrors the provider object but does not echo it back', async () => {
    const { service, prisma, blindpay } = makeService();
    blindpay.post.mockResolvedValue({
      id: 'bw_000000000000',
      network: 'stellar',
      address: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
    });

    const result = await service.create(CONSUMER, 'rcv_1', {
      name: 'Primary wallet',
      network: 'stellar',
    } as any);

    const args = prisma.blindpayBlockchainWallet.upsert.mock.calls[0][0];
    expect(args.create.raw).toEqual(
      expect.objectContaining({ id: 'bw_000000000000' }),
    );
    expect(args.select).toBe(WALLET_PUBLIC_SELECT);
    expect(result).not.toHaveProperty('raw');
  });
});
