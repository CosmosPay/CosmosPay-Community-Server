import { PluginQuotaError } from '@/plugins/plugin-errors';
import { PluginStorageService } from '@/plugins/plugin-storage.service';
import { PLUGIN_MAX_RECORDS_PER_INSTALLATION } from '@/plugins/plugins.constants';
import { PluginError } from '@/plugins/sdk';

describe('PluginStorageService', () => {
  function build(count = 0) {
    const prisma = {
      pluginRecord: {
        findUnique: jest.fn().mockResolvedValue({ value: ['vip'] }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(count),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const storage = new PluginStorageService(prisma as any).forInstallation(
      'inst_1',
      'customer-tags',
    );
    return { prisma, storage };
  }

  it('scopes every read and write to the installation it was built for', async () => {
    const { prisma, storage } = build();

    await storage.get('tags', 'cus_1');
    await storage.put('tags', 'cus_1', ['vip']);
    await storage.delete('tags', 'cus_1');
    await storage.list('tags');

    expect(prisma.pluginRecord.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          installationId_collection_key: {
            installationId: 'inst_1',
            collection: 'tags',
            key: 'cus_1',
          },
        },
      }),
    );
    for (const call of [
      prisma.pluginRecord.updateMany.mock.calls[0][0],
      prisma.pluginRecord.create.mock.calls[0][0].data,
      prisma.pluginRecord.deleteMany.mock.calls[0][0].where,
      prisma.pluginRecord.findMany.mock.calls[0][0].where,
    ]) {
      expect(JSON.stringify(call)).toContain('"installationId":"inst_1"');
    }
  });

  it('refuses an insert past the installation cap, but still allows overwrites', async () => {
    const { prisma, storage } = build(PLUGIN_MAX_RECORDS_PER_INSTALLATION);

    await expect(storage.put('tags', 'new', ['x'])).rejects.toBeInstanceOf(
      PluginQuotaError,
    );
    expect(prisma.pluginRecord.create).not.toHaveBeenCalled();

    prisma.pluginRecord.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      storage.put('tags', 'existing', ['x']),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['a collection with a path in it', '../other', 'k'],
    ['a key with whitespace', 'tags', 'a b'],
    ['an empty key', 'tags', ''],
  ])('refuses %s', async (_label, collection, key) => {
    const { prisma, storage } = build();
    await expect(storage.get(collection, key)).rejects.toBeInstanceOf(
      PluginError,
    );
    expect(prisma.pluginRecord.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a value that is too large, null, or not JSON', async () => {
    const { storage } = build();
    await expect(
      storage.put('tags', 'k', 'x'.repeat(20 * 1024)),
    ).rejects.toThrow(/at most/);
    await expect(storage.put('tags', 'k', null)).rejects.toThrow(/not null/);
    const cyclic: any = {};
    cyclic.self = cyclic;
    await expect(storage.put('tags', 'k', cyclic)).rejects.toThrow(
      /JSON-serializable/,
    );
  });

  it('pages by key with a cursor', async () => {
    const { prisma, storage } = build();
    const row = (key: string) => ({ key, value: 1, updatedAt: new Date(0) });
    prisma.pluginRecord.findMany.mockResolvedValue([
      row('a'),
      row('b'),
      row('c'),
    ]);

    const page = await storage.list('tags', { take: 2 });

    expect(page.items.map((i) => i.key)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBe('b');
    expect(prisma.pluginRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 3, orderBy: { key: 'asc' } }),
    );
  });
});
