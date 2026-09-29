import { Injectable } from '@nestjs/common';
import type { Prisma } from '@generated/prisma/client';
import { isUniqueViolation } from '@/common/prisma-errors';
import { PrismaService } from '@/prisma/prisma.service';
import { PluginQuotaError } from '@/plugins/plugin-errors';
import {
  PLUGIN_COLLECTION_RE,
  PLUGIN_KEY_RE,
  PLUGIN_MAX_PAGE_SIZE,
  PLUGIN_MAX_RECORDS_PER_INSTALLATION,
  PLUGIN_MAX_VALUE_BYTES,
} from '@/plugins/plugins.constants';
import {
  PluginError,
  type PluginJson,
  type PluginStorage,
  type PluginStoredRecord,
} from '@/plugins/sdk';

/**
 * A plugin's own records — the `plugin_record` table, and the only writer of it.
 *
 * Every query here carries `installationId`, and the installation is resolved by
 * the runtime from the calling consumer and the plugin's slug. A plugin never
 * supplies it: `ctx.storage` has no parameter that could name another tenant's
 * installation or another plugin's, so there is nothing to forge.
 */
@Injectable()
export class PluginStorageService {
  constructor(private readonly prisma: PrismaService) {}

  /** The storage API one installation's plugin code sees. */
  forInstallation(installationId: string, slug: string): PluginStorage {
    return {
      get: (collection, key) => this.get(installationId, collection, key),
      put: (collection, key, value) =>
        this.put(installationId, slug, collection, key, value),
      delete: (collection, key) => this.delete(installationId, collection, key),
      list: (collection, options) =>
        this.list(installationId, collection, options),
    };
  }

  private async get(
    installationId: string,
    collection: string,
    key: string,
  ): Promise<PluginJson | null> {
    assertCollection(collection);
    assertKey(key);
    const row = await this.prisma.pluginRecord.findUnique({
      where: {
        installationId_collection_key: { installationId, collection, key },
      },
      select: { value: true },
    });
    return row ? (row.value as PluginJson) : null;
  }

  private async put(
    installationId: string,
    slug: string,
    collection: string,
    key: string,
    value: PluginJson,
  ): Promise<void> {
    assertCollection(collection);
    assertKey(key);
    const json = serializeValue(value);
    const where = {
      installationId_collection_key: { installationId, collection, key },
    };

    // An overwrite never grows the installation, so it skips the count. The
    // cap is checked before an insert, not atomically with it: two concurrent
    // inserts at the cap can land one record over. It bounds a runaway plugin,
    // not an exact number, and a lock per write would cost more than it saves.
    const updated = await this.prisma.pluginRecord.updateMany({
      where: where.installationId_collection_key,
      data: { value: json },
    });
    if (updated.count > 0) return;

    const count = await this.prisma.pluginRecord.count({
      where: { installationId },
    });
    if (count >= PLUGIN_MAX_RECORDS_PER_INSTALLATION) {
      throw new PluginQuotaError(
        `Plugin ${slug} has reached its limit of ${PLUGIN_MAX_RECORDS_PER_INSTALLATION} records.`,
      );
    }
    try {
      await this.prisma.pluginRecord.create({
        data: { installationId, collection, key, value: json },
      });
    } catch (err) {
      // A concurrent put created it between the update and the insert.
      if (!isUniqueViolation(err)) throw err;
      await this.prisma.pluginRecord.update({ where, data: { value: json } });
    }
  }

  private async delete(
    installationId: string,
    collection: string,
    key: string,
  ): Promise<boolean> {
    assertCollection(collection);
    assertKey(key);
    const { count } = await this.prisma.pluginRecord.deleteMany({
      where: { installationId, collection, key },
    });
    return count > 0;
  }

  private async list(
    installationId: string,
    collection: string,
    options: { prefix?: string; take?: number; after?: string } = {},
  ): Promise<{ items: PluginStoredRecord[]; nextCursor: string | null }> {
    assertCollection(collection);
    if (options.prefix !== undefined && options.prefix !== '') {
      assertKey(options.prefix);
    }
    if (options.after !== undefined) assertKey(options.after);
    const take = Math.min(
      Math.max(Math.trunc(options.take ?? PLUGIN_MAX_PAGE_SIZE), 1),
      PLUGIN_MAX_PAGE_SIZE,
    );

    const rows = await this.prisma.pluginRecord.findMany({
      where: {
        installationId,
        collection,
        key: {
          ...(options.prefix ? { startsWith: options.prefix } : {}),
          ...(options.after ? { gt: options.after } : {}),
        },
      },
      orderBy: { key: 'asc' },
      // One extra row says whether there is a next page without a count.
      take: take + 1,
      select: { key: true, value: true, updatedAt: true },
    });

    const page = rows.slice(0, take);
    return {
      items: page.map((row) => ({
        key: row.key,
        value: row.value as PluginJson,
        updatedAt: row.updatedAt.toISOString(),
      })),
      nextCursor: rows.length > take ? page[page.length - 1].key : null,
    };
  }
}

function assertCollection(collection: string): void {
  if (
    typeof collection !== 'string' ||
    !PLUGIN_COLLECTION_RE.test(collection)
  ) {
    throw new PluginError(
      `Storage collection must match ${PLUGIN_COLLECTION_RE}`,
    );
  }
}

function assertKey(key: string): void {
  if (typeof key !== 'string' || !PLUGIN_KEY_RE.test(key)) {
    throw new PluginError(`Storage key must match ${PLUGIN_KEY_RE}`);
  }
}

/**
 * Round-trips the value through JSON: it must be plain data (no functions,
 * cycles, class instances or `undefined` at the top), and what is stored is a
 * copy the plugin keeps no reference into.
 */
function serializeValue(value: PluginJson): Prisma.InputJsonValue {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new PluginError('Storage value must be JSON-serializable');
  }
  if (text === undefined || value === null) {
    throw new PluginError(
      'Storage value must be JSON and not null — delete the key instead',
    );
  }
  if (Buffer.byteLength(text) > PLUGIN_MAX_VALUE_BYTES) {
    throw new PluginError(
      `Storage value must be at most ${PLUGIN_MAX_VALUE_BYTES} bytes as JSON`,
    );
  }
  return JSON.parse(text) as Prisma.InputJsonValue;
}
