import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadPlugins } from '@/plugins/plugin-folder';
import { supportKeys } from '@/plugins/plugin-signature';
import {
  PluginError,
  type PluginContext,
  type PluginDefinition,
  type PluginJson,
} from '@/plugins/sdk';

/**
 * The repository's `plugins/` folder: every plugin in it, enabled or not, must
 * load on a deployment that configured nothing — that is what "preinstalled by
 * support" means. A plugin committed without a valid support signature, or
 * edited after it was signed, fails here rather than at someone's boot.
 */
const PLUGINS = join(__dirname, '..', '..', 'plugins');

const slugs = readdirSync(PLUGINS).filter((entry) =>
  statSync(join(PLUGINS, entry)).isDirectory(),
);

function loadShipped(slug: string): PluginDefinition {
  const [plugin] = loadPlugins({
    root: PLUGINS,
    slugs: [slug],
    // Support's keys only: no PLUGINS_TRUSTED_KEYS, no unsigned.
    trustedKeys: supportKeys(),
    allowUnsigned: false,
    nodeEnv: 'production',
    warn: jest.fn(),
  });
  return plugin;
}

describe('plugins/', () => {
  it('ships the example plugin', () => {
    expect(slugs).toContain('example');
  });

  it.each(slugs)(
    '%s is readable, signed by support and valid with no configuration',
    (slug) => {
      for (const file of ['plugin.json', 'index.ts', 'signature.json']) {
        expect(existsSync(join(PLUGINS, slug, file))).toBe(true);
      }
      expect(loadShipped(slug).slug).toBe(slug);
    },
  );
});

describe('the example plugin', () => {
  const example = loadShipped('example');

  function context(
    intents: string[],
    config: Record<string, string> = {},
  ): PluginContext {
    const records = new Map<string, PluginJson>();
    return {
      plugin: { slug: 'example', version: '1.0.0' },
      installation: { id: 'inst_1', config },
      storage: {
        get: (c, k) => Promise.resolve(records.get(`${c}/${k}`) ?? null),
        put: (c, k, v) => {
          records.set(`${c}/${k}`, v);
          return Promise.resolve();
        },
        delete: (c, k) => Promise.resolve(records.delete(`${c}/${k}`)),
        list: () => Promise.resolve({ items: [], nextCursor: null }),
      },
      core: {
        paymentIntents: {
          get: (id: string) =>
            Promise.resolve(intents.includes(id) ? ({ id } as any) : null),
        },
      } as any,
      http: { request: jest.fn() },
      log: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };
  }

  const notesOf = async (ctx: PluginContext) =>
    (
      (await example.queries!['get-notes'](ctx, {
        paymentIntentId: 'pi_1',
      })) as { notes: { text: string; source: string }[] }
    ).notes;

  it('declares only a read of payment intents, and no network', () => {
    expect(example.capabilities).toEqual(['payment_intents:read']);
    expect(example.egress).toEqual([]);
  });

  it('adds a note to the tenant’s intent and reads it back', async () => {
    const ctx = context(['pi_1'], { label: 'ops' });
    await example.commands!['add-note'](ctx, {
      paymentIntentId: 'pi_1',
      text: 'Customer called',
    });
    expect(await notesOf(ctx)).toEqual([
      expect.objectContaining({
        text: '[ops] Customer called',
        source: 'tenant',
      }),
    ]);
  });

  it('refuses an intent the tenant does not have', async () => {
    await expect(
      Promise.resolve().then(() =>
        example.commands!['add-note'](context([]), {
          paymentIntentId: 'pi_x',
          text: 'x',
        }),
      ),
    ).rejects.toBeInstanceOf(PluginError);
  });

  it('records a note when the intent is paid', async () => {
    const ctx = context(['pi_1']);
    await example.events!.PAYMENT_INTENT_SUCCEEDED!(ctx, {
      type: 'PAYMENT_INTENT_SUCCEEDED',
      data: {
        id: 'pi_1',
        amount: '25',
        asset: 'native',
        txHash: 'abcdef0123456789',
      } as any,
    });
    expect(await notesOf(ctx)).toEqual([
      expect.objectContaining({
        text: 'Paid 25 native in abcdef012345…',
        source: 'event',
      }),
    ]);
  });
});
