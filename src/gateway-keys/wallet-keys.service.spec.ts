import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import { ApiErrorCode } from '@/common/errors/api-error';
import { ApisixAdminClient } from '@/gateway-keys/apisix-admin.client';
import { GATEWAY_KEY_RE } from '@/gateway-keys/gateway-keys.constants';
import { WalletKeysService } from '@/gateway-keys/wallet-keys.service';

const DEV_KEY = `dv_${'a'.repeat(64)}`;
const PROD_KEY = `prod_${'b'.repeat(64)}`;

function makeService(configured = true) {
  const admin = {
    configured,
    listCredentials: jest.fn().mockResolvedValue([]),
    listWalletConsumers: jest.fn().mockResolvedValue([]),
    getConsumerForwarder: jest.fn().mockResolvedValue(null),
    putConsumer: jest.fn().mockResolvedValue(undefined),
    putCredential: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: jest.fn().mockReturnValue({ walletSwapFeeBps: 150 }),
  } as unknown as ConfigService<AppConfig, true>;
  const service = new WalletKeysService(
    admin as unknown as ApisixAdminClient,
    config,
  );
  return { service, admin };
}

/** The Lua body the last consumer write baked. */
function bakedForwarder(admin: { putConsumer: jest.Mock }): string {
  const plugins = admin.putConsumer.mock.calls[0][1] as {
    'serverless-pre-function': { functions: string[] };
  };
  return plugins['serverless-pre-function'].functions[0];
}

describe('WalletKeysService', () => {
  it('mints a dev and a prod key under the account consumer', async () => {
    const { service, admin } = makeService();
    const keys = await service.provision({
      accountId: 'acc1',
      email: 'Ada@Example.com',
    });

    expect(keys.organizationId).toBe('acc1');
    expect(keys.dev).toMatch(/^dv_[0-9a-f]{64}$/);
    expect(keys.prod).toMatch(/^prod_[0-9a-f]{64}$/);
    expect(admin.putCredential).toHaveBeenCalledTimes(2);
    const [username, , cred] = admin.putCredential.mock.calls[0];
    expect(username).toBe('cosmos_wallet_acc1');
    expect(cred.labels).toMatchObject({
      role: 'user',
      env: 'dev',
      org: 'acc1',
    });
    expect(JSON.parse(cred.labels.permissions)).toContain('swaps:write');
  });

  /* A key that authenticates before its forwarder entry exists arrives with no scopes. */
  it('writes the consumer forwarder before the credentials, with every key in it', async () => {
    const { service, admin } = makeService();
    const order: string[] = [];
    admin.putConsumer.mockImplementation(() => {
      order.push('consumer');
      return Promise.resolve();
    });
    admin.putCredential.mockImplementation(() => {
      order.push('credential');
      return Promise.resolve();
    });

    await service.provision({ accountId: 'acc1', email: 'ada@example.com' });

    expect(order).toEqual(['consumer', 'credential', 'credential']);
    const fn = bakedForwarder(admin);
    for (const call of admin.putCredential.mock.calls) {
      expect(fn).toContain(call[1] as string);
    }
    expect(fn).toContain('"em":"ada@example.com"');
    expect(fn).toContain('"f":150');
    expect(admin.putConsumer.mock.calls[0][2]).toEqual({
      source: 'community-server',
      wallet_account: 'acc1',
    });
  });

  it('returns the keys an account already has instead of minting more', async () => {
    const { service, admin } = makeService();
    admin.listCredentials.mockResolvedValue([
      { id: 'cosmos_wk_dev', key: DEV_KEY, labels: { env: 'dev' } },
    ]);

    const keys = await service.provision({
      accountId: 'acc1',
      email: 'ada@example.com',
    });

    expect(keys.dev).toBe(DEV_KEY);
    expect(GATEWAY_KEY_RE.test(keys.prod ?? '')).toBe(true);
    expect(admin.putCredential).toHaveBeenCalledTimes(1);
    expect(admin.putCredential.mock.calls[0][2].labels.env).toBe('prod');
  });

  it('skips the consumer write when the forwarder is already current', async () => {
    const { service, admin } = makeService();
    admin.listCredentials.mockResolvedValue([
      { id: 'a', key: DEV_KEY, labels: { env: 'dev' } },
      { id: 'b', key: PROD_KEY, labels: { env: 'prod' } },
    ]);
    await service.provision({ accountId: 'acc1', email: 'ada@example.com' });
    const baked = bakedForwarder(admin);

    admin.putConsumer.mockClear();
    admin.getConsumerForwarder.mockResolvedValue(baked);
    await service.provision({ accountId: 'acc1', email: 'ada@example.com' });

    expect(admin.putConsumer).not.toHaveBeenCalled();
    expect(admin.putCredential).not.toHaveBeenCalled();
  });

  it('forwards no email that could break out of the Lua string', async () => {
    const { service, admin } = makeService();
    await service.provision({ accountId: 'acc1', email: 'x]==]@evil.com' });
    const fn = bakedForwarder(admin);
    expect(fn).toContain('"em":""');
    expect(fn).not.toContain('x]==]');
  });

  it('is a 503 misconfigured when the admin API is not set', async () => {
    const { service } = makeService(false);
    await expect(
      service.provision({ accountId: 'acc1', email: 'ada@example.com' }),
    ).rejects.toMatchObject({ code: ApiErrorCode.Misconfigured });
  });

  it('turns a gateway failure into a retryable 503, not a 500', async () => {
    const { service, admin } = makeService();
    admin.listCredentials.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      service.provision({ accountId: 'acc1', email: 'ada@example.com' }),
    ).rejects.toMatchObject({ code: ApiErrorCode.Misconfigured });
  });

  describe('rebakeSwapFees', () => {
    const LABELS = { source: 'community-server', wallet_account: 'acc1' };

    /** The body `provision` bakes for acc1's two keys at the current rate (150). */
    async function currentBody(): Promise<string> {
      const { service, admin } = makeService();
      admin.listCredentials.mockResolvedValue([
        { id: 'a', key: DEV_KEY, labels: { env: 'dev' } },
        { id: 'b', key: PROD_KEY, labels: { env: 'prod' } },
      ]);
      await service.provision({ accountId: 'acc1', email: 'ada@example.com' });
      return bakedForwarder(admin);
    }

    /* Until this ran, a rate change reached an account only on its next sign-in. */
    it('re-bakes a consumer still on an old rate to exactly what a sign-in would bake', async () => {
      const body = await currentBody();
      const stale = body.replaceAll('"f":150', '"f":50');
      expect(stale).not.toBe(body);
      const { service, admin } = makeService();
      admin.listWalletConsumers.mockResolvedValue([
        { username: 'cosmos_wallet_acc1', forwarder: stale, labels: LABELS },
      ]);

      await expect(service.rebakeSwapFees()).resolves.toEqual({
        rebaked: 1,
        current: 0,
      });

      expect(admin.putConsumer).toHaveBeenCalledTimes(1);
      expect(admin.putConsumer.mock.calls[0][0]).toBe('cosmos_wallet_acc1');
      expect(bakedForwarder(admin)).toBe(body);
      expect(admin.putConsumer.mock.calls[0][2]).toEqual(LABELS);
      expect(admin.putCredential).not.toHaveBeenCalled();
    });

    it('leaves current consumers and bodies it did not write alone', async () => {
      const body = await currentBody();
      const { service, admin } = makeService();
      admin.listWalletConsumers.mockResolvedValue([
        { username: 'cosmos_wallet_acc1', forwarder: body, labels: LABELS },
        { username: 'cosmos_wallet_acc2', forwarder: null, labels: {} },
        {
          username: 'cosmos_wallet_acc3',
          forwarder: 'return function() end',
          labels: {},
        },
      ]);

      await expect(service.rebakeSwapFees()).resolves.toEqual({
        rebaked: 0,
        current: 1,
      });
      expect(admin.putConsumer).not.toHaveBeenCalled();
    });

    it('keeps going past a consumer whose write fails', async () => {
      const stale = (await currentBody()).replaceAll('"f":150', '"f":50');
      const { service, admin } = makeService();
      admin.listWalletConsumers.mockResolvedValue([
        { username: 'cosmos_wallet_acc1', forwarder: stale, labels: LABELS },
        { username: 'cosmos_wallet_acc2', forwarder: stale, labels: LABELS },
      ]);
      admin.putConsumer.mockRejectedValueOnce(new Error('500'));

      await expect(service.rebakeSwapFees()).resolves.toEqual({
        rebaked: 1,
        current: 0,
      });
      expect(admin.putConsumer).toHaveBeenCalledTimes(2);
    });

    it('runs at boot only where the admin API is set, and never fails the boot', async () => {
      const off = makeService(false);
      off.service.onApplicationBootstrap();
      expect(off.admin.listWalletConsumers).not.toHaveBeenCalled();

      const on = makeService();
      on.admin.listWalletConsumers.mockRejectedValue(new Error('ECONNREFUSED'));
      expect(() => on.service.onApplicationBootstrap()).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
      expect(on.admin.listWalletConsumers).toHaveBeenCalledTimes(1);
    });
  });
});
