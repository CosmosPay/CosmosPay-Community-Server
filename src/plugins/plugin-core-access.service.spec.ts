import { ApiError } from '@/common/errors/api-error';
import { PluginViolationError } from '@/plugins/plugin-errors';
import { PluginCoreAccessService } from '@/plugins/plugin-core-access.service';
import { PluginError, type PluginCapability } from '@/plugins/sdk';

describe('PluginCoreAccessService', () => {
  const consumer = { username: 'cosmos_u1', credentialId: 'cred_1' } as any;
  const customer = {
    id: 'cus_1',
    name: 'Ada',
    alias: null,
    email: 'ada@example.com',
    account: null,
    note: null,
    reference: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    // What a core read may carry that a plugin must never see.
    consumerId: 'c_internal',
    raw: { secret: true },
  };
  const intent = {
    id: 'pi_1',
    status: 'SUCCEEDED',
    destination: 'GDEST',
    xdr: 'AAAA',
    uri: 'web+stellar:tx?xdr=AAAA',
    consumerId: 'c_internal',
  };

  function build(granted: PluginCapability[]) {
    const customers = {
      findAll: jest.fn().mockResolvedValue({
        data: [customer],
        total: 1,
        take: 100,
        skip: 0,
      }),
      findOne: jest.fn().mockResolvedValue(customer),
      create: jest.fn().mockResolvedValue(customer),
      update: jest.fn().mockResolvedValue(customer),
      remove: jest.fn(),
    };
    const products = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    const paymentIntents = {
      findAll: jest.fn(),
      findOne: jest.fn().mockResolvedValue(intent),
    };
    const core = new PluginCoreAccessService(
      customers as any,
      products as any,
      paymentIntents as any,
    ).forConsumer(consumer, new Set(granted), 'acme');
    return { core, customers, products, paymentIntents };
  }

  it('refuses a capability the installation was not granted', async () => {
    const { core, customers } = build(['customers:read']);

    await expect(
      core.customers.create({ name: 'Mallory' }),
    ).rejects.toBeInstanceOf(PluginViolationError);
    await expect(core.products.list()).rejects.toBeInstanceOf(
      PluginViolationError,
    );
    expect(customers.create).not.toHaveBeenCalled();
  });

  it('calls the owning service with the calling consumer, never one the plugin names', async () => {
    const { core, customers } = build(['customers:read']);

    await core.customers.get('cus_1');

    expect(customers.findOne).toHaveBeenCalledWith(consumer, 'cus_1');
  });

  it('returns a frozen projection without internal fields', async () => {
    const { core, paymentIntents } = build([
      'customers:read',
      'payment_intents:read',
    ]);

    const read = await core.customers.get('cus_1');
    expect(read).not.toHaveProperty('consumerId');
    expect(read).not.toHaveProperty('raw');
    expect(read?.createdAt).toBe('2026-09-01T00:00:00.000Z');
    expect(Object.isFrozen(read)).toBe(true);

    const pi = await core.paymentIntents.get('pi_1');
    expect(pi).not.toHaveProperty('xdr');
    expect(pi).not.toHaveProperty('uri');
    expect(pi).not.toHaveProperty('consumerId');
    expect(paymentIntents.findOne).toHaveBeenCalledWith(consumer, 'pi_1');
  });

  it('validates writes with the core DTO, refusing unknown fields', async () => {
    const { core, customers } = build(['customers:write']);

    await expect(
      core.customers.create({ name: 'Ada', consumerId: 'c_other' } as any),
    ).rejects.toThrow(PluginError);
    await expect(
      core.customers.create({ name: 'Ada', email: 'not-an-email' }),
    ).rejects.toThrow(/email/);
    expect(customers.create).not.toHaveBeenCalled();

    await core.customers.create({ name: 'Ada' });
    expect(customers.create).toHaveBeenCalledWith(
      consumer,
      expect.objectContaining({ name: 'Ada' }),
    );
  });

  it('has no delete, and no payment intent write, at all', () => {
    const { core } = build([
      'customers:write',
      'products:write',
      'payment_intents:read',
    ]);
    expect(core.customers).not.toHaveProperty('remove');
    expect(core.customers).not.toHaveProperty('delete');
    expect(core.products).not.toHaveProperty('remove');
    expect(Object.keys(core.paymentIntents).sort()).toEqual(['get', 'list']);
  });

  it('reads another tenant’s row as absent, and refuses to update it', async () => {
    const { core, customers } = build(['customers:read', 'customers:write']);
    customers.findOne.mockRejectedValue(
      ApiError.notFound('Customer not found'),
    );
    customers.update.mockRejectedValue(ApiError.notFound('Customer not found'));

    await expect(core.customers.get('cus_other')).resolves.toBeNull();
    await expect(
      core.customers.update('cus_other', { note: 'x' }),
    ).rejects.toThrow(PluginError);
  });

  it('refuses an id that is not a core id before querying', async () => {
    const { core, customers } = build(['customers:read']);
    await expect(core.customers.get('a/b')).rejects.toThrow(PluginError);
    await expect(core.customers.get({} as any)).rejects.toThrow(PluginError);
    expect(customers.findOne).not.toHaveBeenCalled();
  });
});
