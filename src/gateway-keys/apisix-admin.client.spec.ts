import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import { ApisixAdminClient } from '@/gateway-keys/apisix-admin.client';

function makeClient() {
  const config = {
    get: jest.fn().mockReturnValue({
      url: 'http://apisix:9180/apisix/admin',
      key: 'admin-key',
      timeoutMs: 1000,
      walletSwapFeeBps: 150,
    }),
  } as unknown as ConfigService<AppConfig, true>;
  return new ApisixAdminClient(config);
}

describe('ApisixAdminClient', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
  });
  afterEach(() => jest.restoreAllMocks());

  /* The admin key can do anything; the client is what narrows it. */
  it('refuses to write any consumer outside the wallet namespace', async () => {
    const client = makeClient();
    await expect(client.putConsumer('cosmos_public', {}, {})).rejects.toThrow(
      /Refusing/,
    );
    await expect(
      client.putCredential('cosmos_someone', 'c1', {
        key: 'k',
        labels: {},
        name: 'n',
        desc: 'd',
      }),
    ).rejects.toThrow(/Refusing/);
    await expect(
      client.listCredentials('cosmos_wallet_../routes'),
    ).rejects.toThrow(/Refusing/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('authenticates with the admin key and reads credentials', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          list: [
            {
              value: {
                id: 'cosmos_wk_1',
                labels: { env: 'dev' },
                plugins: { 'key-auth': { key: 'dv_x' } },
              },
            },
          ],
        }),
    });
    const creds = await makeClient().listCredentials('cosmos_wallet_acc1');
    expect(creds).toEqual([
      { id: 'cosmos_wk_1', key: 'dv_x', labels: { env: 'dev' } },
    ]);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(
      'http://apisix:9180/apisix/admin/consumers/cosmos_wallet_acc1/credentials',
    );
    expect(init.headers['x-api-key']).toBe('admin-key');
  });

  /* The list holds every developer's consumer too; none of them may leak out. */
  it('lists only the wallet consumers', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          list: [
            {
              value: {
                username: 'cosmos_wallet_acc1',
                labels: { wallet_account: 'acc1' },
                plugins: {
                  'serverless-pre-function': { functions: ['return 1'] },
                },
              },
            },
            {
              value: {
                username: 'cosmos_someone',
                plugins: {
                  'serverless-pre-function': { functions: ['return 2'] },
                },
              },
            },
            { value: { username: 'cosmos_wallet_acc2' } },
          ],
        }),
    });
    await expect(makeClient().listWalletConsumers()).resolves.toEqual([
      {
        username: 'cosmos_wallet_acc1',
        forwarder: 'return 1',
        labels: { wallet_account: 'acc1' },
      },
      { username: 'cosmos_wallet_acc2', forwarder: null, labels: {} },
    ]);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
      'http://apisix:9180/apisix/admin/consumers',
    );
  });

  it('treats a missing consumer as no credentials', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 404 });
    await expect(
      makeClient().listCredentials('cosmos_wallet_acc1'),
    ).resolves.toEqual([]);
  });
});
