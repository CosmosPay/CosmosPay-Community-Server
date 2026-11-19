import { P2pWebhooks } from '@/p2p/p2p-webhooks.service';
import type { P2pOrderRow } from '@/p2p/p2p-views';

const USERS: Record<string, string> = {
  consumer_client: 'cosmos_client',
  consumer_merchant: 'cosmos_merchant',
};

function setup() {
  const emit = jest.fn().mockResolvedValue(true);
  const prisma = {
    consumer: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          USERS[where.id] ? { apisixUsername: USERS[where.id] } : null,
        ),
      ),
    },
  };
  return {
    webhooks: new P2pWebhooks(prisma as never, { emit } as never),
    emit,
  };
}

const row = (overrides: Partial<P2pOrderRow> = {}) =>
  ({
    id: '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10',
    consumerId: 'consumer_client',
    merchantConsumerId: 'consumer_merchant',
    tier: 'testnet',
    network: 'base',
    kind: 'BUY',
    externalReference: 'client-only',
    txHashes: undefined,
    ...overrides,
  }) as unknown as P2pOrderRow;

describe('P2pWebhooks', () => {
  it('notifies the client and the merchant, each with its own role, projection and epoch', async () => {
    const { webhooks, emit } = setup();
    await webhooks.order('P2P_ORDER_COMPLETED', row());
    expect(emit).toHaveBeenCalledTimes(2);
    const [client, merchant] = emit.mock.calls;
    expect(client[0]).toBe('cosmos_client');
    expect(client[2]).toMatchObject({
      role: 'client',
      settlementEpoch: 0,
      chainId: 84532,
      externalReference: 'client-only',
    });
    expect(merchant[0]).toBe('cosmos_merchant');
    expect(merchant[2]).toMatchObject({ role: 'merchant', settlementEpoch: 1 });
    expect(merchant[2]).not.toHaveProperty('externalReference');
  });

  it('notifies once when the client is its own merchant', async () => {
    const { webhooks, emit } = setup();
    await webhooks.order(
      'P2P_ORDER_PAID',
      row({ merchantConsumerId: 'consumer_client' }),
    );
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][2]).toMatchObject({ role: 'client' });
  });

  it('never throws into the indexer', async () => {
    const { webhooks, emit } = setup();
    emit.mockRejectedValue(new Error('database down'));
    await expect(
      webhooks.order('P2P_ORDER_PAID', row()),
    ).resolves.toBeUndefined();
  });

  it('dedups a charge success per paying order', async () => {
    const { webhooks, emit } = setup();
    await webhooks.chargeSucceeded('consumer_client', {
      id: 'charge_1',
      orderId: 'order_2',
      paidCount: 2,
    });
    expect(emit.mock.calls[0][1]).toBe('P2P_CHARGE_SUCCEEDED');
    expect(emit.mock.calls[0][2]).toMatchObject({
      id: 'charge_1',
      orderId: 'order_2',
      settlementEpoch: 2,
    });
  });
});
