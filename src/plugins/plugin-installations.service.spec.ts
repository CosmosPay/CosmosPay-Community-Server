import { ApiError } from '@/common/errors/api-error';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { PluginInstallationsService } from '@/plugins/plugin-installations.service';
import { definePlugin } from '@/plugins/sdk';

const SECRET = 'x'.repeat(32);

const acme = definePlugin({
  slug: 'acme',
  name: 'Acme',
  version: '2.0.0',
  description: 'd',
  author: 'a',
  capabilities: ['customers:read', 'products:read'],
  config: {
    apiKey: { type: 'string', description: 'k', required: true, secret: true },
    region: { type: 'string', description: 'r' },
  },
});

const consumer = { username: 'cosmos_u1', credentialId: 'cred_1' } as any;

function build(existing: Record<string, unknown> | null = null) {
  let stored: any = existing;
  const prisma = {
    consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
    pluginInstallation: {
      findFirst: jest.fn(() => Promise.resolve(stored)),
      findMany: jest.fn(() => Promise.resolve(stored ? [stored] : [])),
      upsert: jest.fn(({ create, update }: any) => {
        stored = {
          id: 'inst_1',
          createdAt: new Date(0),
          updatedAt: new Date(0),
          ...(stored ?? create),
          ...(stored ? update : {}),
        };
        return Promise.resolve(stored);
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const registry = {
    get: (slug: string) => (slug === 'acme' ? acme : undefined),
    list: () => [acme],
  };
  const config = { get: () => ({ enabled: ['acme'], secret: SECRET }) } as any;
  const service = new PluginInstallationsService(
    prisma as any,
    new ConsumerResolverService(prisma as never),
    registry as any,
    config,
  );
  return { service, prisma, stored: () => stored };
}

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected an ApiError');
}

describe('PluginInstallationsService', () => {
  it('refuses a consent that is not exactly the declared capabilities', async () => {
    const { service, prisma } = build();

    for (const grant of [
      ['customers:read'],
      ['customers:read', 'products:read', 'customers:write'],
      ['customers:read', 'customers:read'],
    ]) {
      const err = await apiError(
        service.install(consumer, 'acme', {
          grantCapabilities: grant,
          config: { apiKey: 'k' },
        }),
      );
      expect(err.getResponse()).toMatchObject({
        code: 'plugin_consent_mismatch',
      });
    }
    expect(prisma.pluginInstallation.upsert).not.toHaveBeenCalled();
  });

  it('seals secrets at rest and never returns them', async () => {
    const { service, stored } = build();

    const view = await service.install(consumer, 'acme', {
      grantCapabilities: ['products:read', 'customers:read'],
      config: { apiKey: 'sk_live_topsecret', region: 'eu' },
    });

    expect(JSON.stringify(view)).not.toContain('sk_live_topsecret');
    expect(view.installation).toMatchObject({
      config: { region: 'eu' },
      secretsSet: ['apiKey'],
      pendingCapabilities: [],
    });
    expect(JSON.stringify(stored())).not.toContain('sk_live_topsecret');

    // The runtime, and only the runtime, gets the plaintext.
    const resolved = await service.resolve('cosmos_u1', acme);
    expect(resolved.config).toEqual({
      region: 'eu',
      apiKey: 'sk_live_topsecret',
    });
  });

  it('keeps a stored secret the tenant does not resend on re-install', async () => {
    const { service } = build();
    const grantCapabilities = ['customers:read', 'products:read'];
    await service.install(consumer, 'acme', {
      grantCapabilities,
      config: { apiKey: 'sk_1' },
    });

    await service.install(consumer, 'acme', {
      grantCapabilities,
      config: { region: 'us' },
    });

    const resolved = await service.resolve('cosmos_u1', acme);
    expect(resolved.config).toEqual({ region: 'us', apiKey: 'sk_1' });
  });

  it('409s an installation whose consent predates the capabilities asked for now', async () => {
    const { service } = build({
      id: 'inst_1',
      pluginSlug: 'acme',
      pluginVersion: '1.0.0',
      grantedCapabilities: ['customers:read'],
      config: {},
      sealedSecrets: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    const err = await apiError(service.resolve('cosmos_u1', acme));
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: 'plugin_not_installed' });

    const view = await service.describe(consumer, 'acme');
    expect(view.installation?.pendingCapabilities).toEqual(['products:read']);
  });

  it('409s a plugin that is not installed, and 404s one that is not served', async () => {
    const { service } = build();
    expect(
      (await apiError(service.resolve('cosmos_u1', acme))).getStatus(),
    ).toBe(409);
    expect(
      (await apiError(service.describe(consumer, 'ghost'))).getStatus(),
    ).toBe(404);
  });

  it('lets a tenant uninstall a plugin the deployment no longer serves', async () => {
    const { service, prisma } = build();
    // `ghost` is not in the registry: its data must still be deletable.
    await expect(service.uninstall(consumer, 'ghost')).resolves.toEqual({
      slug: 'ghost',
      uninstalled: true,
    });
    expect(prisma.pluginInstallation.deleteMany).toHaveBeenCalledWith({
      where: { pluginSlug: 'ghost', consumer: { apisixUsername: 'cosmos_u1' } },
    });
  });

  it('scopes uninstall to the calling consumer', async () => {
    const { service, prisma } = build();
    await service.uninstall(consumer, 'acme');
    expect(prisma.pluginInstallation.deleteMany).toHaveBeenCalledWith({
      where: {
        pluginSlug: 'acme',
        consumer: { apisixUsername: 'cosmos_u1' },
      },
    });
  });
});
