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
    prisma.pluginRecord.findUnique.mockResolvedValue(null);

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

  describe('compareAndSet', () => {
    const uniqueViolation = () =>
      Object.assign(new Error('dup'), { code: 'P2002' });

    it('with null expected, creates the record and reports whether it did', async () => {
      const { prisma, storage } = build();

      await expect(
        storage.compareAndSet('rfqs', 'r1', null, { v: 1 }),
      ).resolves.toBe(true);
      expect(prisma.pluginRecord.create).toHaveBeenCalledWith({
        data: {
          installationId: 'inst_1',
          collection: 'rfqs',
          key: 'r1',
          value: { v: 1 },
        },
      });
      expect(prisma.pluginRecord.updateMany).not.toHaveBeenCalled();

      // The record exists: the unique index refuses the second insert, and the
      // stored value is left as it was.
      prisma.pluginRecord.create.mockRejectedValueOnce(uniqueViolation());
      await expect(
        storage.compareAndSet('rfqs', 'r1', null, { v: 2 }),
      ).resolves.toBe(false);
      expect(prisma.pluginRecord.update).not.toHaveBeenCalled();
    });

    it('replaces only when the stored value still equals the expected one', async () => {
      const { prisma, storage } = build();
      prisma.pluginRecord.updateMany.mockResolvedValueOnce({ count: 1 });

      await expect(
        storage.compareAndSet('rfqs', 'r1', { v: 1 }, { v: 2 }),
      ).resolves.toBe(true);
      expect(prisma.pluginRecord.updateMany).toHaveBeenCalledWith({
        where: {
          installationId: 'inst_1',
          collection: 'rfqs',
          key: 'r1',
          value: { equals: { v: 1 } },
        },
        data: { value: { v: 2 } },
      });

      // A concurrent writer got there first: nothing matches, nothing written.
      prisma.pluginRecord.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(
        storage.compareAndSet('rfqs', 'r1', { v: 1 }, { v: 3 }),
      ).resolves.toBe(false);
      expect(prisma.pluginRecord.create).not.toHaveBeenCalled();
    });

    it('at the cap, answers false for a record that exists and a quota error for a new one', async () => {
      const { prisma, storage } = build(PLUGIN_MAX_RECORDS_PER_INSTALLATION);

      await expect(
        storage.compareAndSet('rfqs', 'r1', null, { v: 1 }),
      ).resolves.toBe(false);

      prisma.pluginRecord.findUnique.mockResolvedValueOnce(null);
      await expect(
        storage.compareAndSet('rfqs', 'r2', null, { v: 1 }),
      ).rejects.toBeInstanceOf(PluginQuotaError);
      expect(prisma.pluginRecord.create).not.toHaveBeenCalled();
    });

    it('validates the key and both values like put does', async () => {
      const { storage } = build();
      await expect(
        storage.compareAndSet('rfqs', 'a b', null, 1),
      ).rejects.toBeInstanceOf(PluginError);
      await expect(
        storage.compareAndSet('rfqs', 'r1', null, null),
      ).rejects.toThrow(/not null/);
      await expect(
        storage.compareAndSet('rfqs', 'r1', 'x'.repeat(20 * 1024), 1),
      ).rejects.toThrow(/at most/);
    });
  });

  it('refuses a page size that is not a number', async () => {
    const { prisma, storage } = build();
    await expect(
      storage.list('tags', { take: 'ten' as never }),
    ).rejects.toBeInstanceOf(PluginError);
    expect(prisma.pluginRecord.findMany).not.toHaveBeenCalled();
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
