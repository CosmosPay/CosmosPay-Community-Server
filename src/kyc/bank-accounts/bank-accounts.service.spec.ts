import {
  BANK_ACCOUNT_PUBLIC_SELECT,
  BankAccountsService,
} from './bank-accounts.service';

const CONSUMER = { username: 'cosmos_u1', role: 'user' } as any;

/**
 * The mirrored row as PostgreSQL holds it. `raw` is the BlindPay object, which for a
 * bank account is the account credentials themselves — the thing these tests exist to
 * keep out of responses.
 */
function bankRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ba_local_1',
    consumerId: 'c1',
    receiverId: 'rcv_1',
    blindpayId: 'ba_000000000000',
    rail: 'ach',
    name: 'Acme payouts — USD',
    country: 'US',
    raw: {
      account_number: '000123456789',
      routing_number: '021000021',
      pix_key: '123.456.789-00',
    },
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
    blindpayBankAccount: {
      // Default to Prisma's real behaviour: store the full row, return only
      // what `select` asks for. A test may still override with mockResolvedValue.
      findMany: jest.fn(({ select }: any) =>
        Promise.resolve([applySelect(bankRow(), select)]),
      ),
      count: jest.fn().mockResolvedValue(1),
      findFirst: jest.fn(({ select }: any) =>
        Promise.resolve(applySelect(bankRow(), select)),
      ),
      delete: jest.fn(),
      upsert: jest.fn(({ select }: any) =>
        Promise.resolve(applySelect(bankRow(), select)),
      ),
    },
  };
  const blindpay = {
    post: jest.fn(),
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
  const service = new BankAccountsService(
    prisma,
    blindpay as any,
    consumers as any,
    receivers as any,
  );
  return { service, prisma, blindpay, receivers };
}

describe('BankAccountsService.findAll', () => {
  it('never selects the provider blob holding the account credentials', async () => {
    const { service, prisma } = makeService();
    prisma.blindpayBankAccount.count.mockResolvedValue(1);

    const result = await service.findAll(CONSUMER, 'rcv_1', {
      take: 100,
      skip: 0,
    });

    expect(BANK_ACCOUNT_PUBLIC_SELECT).not.toHaveProperty('raw');
    expect(prisma.blindpayBankAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: BANK_ACCOUNT_PUBLIC_SELECT }),
    );
    expect(result.data[0]).not.toHaveProperty('raw');
  });

  it('reports the row count, not the page length', async () => {
    const { service, prisma } = makeService();
    prisma.blindpayBankAccount.count.mockResolvedValue(12);

    const result = await service.findAll(CONSUMER, 'rcv_1', {
      take: 100,
      skip: 0,
    });

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(12);
    expect(prisma.blindpayBankAccount.count).toHaveBeenCalledWith({
      where: { receiverId: 'rcv_1' },
    });
  });
});

describe('BankAccountsService.create', () => {
  it('stores the provider object but returns only the documented fields', async () => {
    const { service, prisma, blindpay } = makeService();
    blindpay.post.mockResolvedValue({
      id: 'ba_000000000000',
      name: 'Acme payouts — USD',
      country: 'US',
      account_number: '000123456789',
    });

    const result = await service.create(CONSUMER, 'rcv_1', {
      type: 'ach',
    } as any);

    const args = prisma.blindpayBankAccount.upsert.mock.calls[0][0];
    expect(args.create.raw).toEqual(
      expect.objectContaining({ account_number: '000123456789' }),
    );
    expect(args.select).toBe(BANK_ACCOUNT_PUBLIC_SELECT);
    expect(result).not.toHaveProperty('raw');
  });
});

describe('BankAccountsService.create refuses a disabled receiver', () => {
  it('checks the kill switch before registering a payout destination', async () => {
    const { service, blindpay, receivers } = makeService();
    const disabled = new Error('This fiat account is disabled');
    receivers.assertEnabled.mockImplementation(() => {
      throw disabled;
    });

    await expect(
      service.create(CONSUMER, 'rcv_1', { type: 'ach' } as any),
    ).rejects.toBe(disabled);

    // The decisive part: nothing reached the provider. Deleting the
    // `assertEnabled` call used to ship green — the spec stubbed it and never
    // asserted it ran, so a disabled receiver could still register a new
    // destination for its payouts.
    expect(blindpay.post).not.toHaveBeenCalled();
  });

  it('registers the destination when the receiver is enabled', async () => {
    const { service, blindpay, receivers } = makeService();
    blindpay.post.mockResolvedValue({
      id: 'ba_1',
      name: 'Acme',
      country: 'US',
    });

    await service.create(CONSUMER, 'rcv_1', { type: 'ach' } as any);

    expect(receivers.assertEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rcv_1' }),
    );
    expect(blindpay.post).toHaveBeenCalled();
  });
});
