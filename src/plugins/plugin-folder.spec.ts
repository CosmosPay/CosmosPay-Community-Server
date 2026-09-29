import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPlugins,
  parseManifest,
  sandboxPluginSource,
  type LoadPluginsOptions,
} from '@/plugins/plugin-folder';
import {
  generateSigningKey,
  parseTrustedKeys,
  signPlugin,
} from '@/plugins/plugin-signature';
import {
  PluginTimeoutError,
  PluginViolationError,
} from '@/plugins/plugin-errors';
import { PluginError } from '@/plugins/sdk';

function manifest(slug: string, version = '1.0.0'): string {
  return JSON.stringify({
    slug,
    name: 'Acme',
    version,
    description: 'd',
    author: 'a',
    capabilities: [],
  });
}

function source(extra = ''): string {
  return `import { defineHandlers, PluginError } from '@/plugins/sdk';
${extra}
export default defineHandlers({
  queries: {
    hello: () => {
      throw new PluginError('nope');
    },
  },
});
`;
}

describe('loadPlugins', () => {
  const key = generateSigningKey();
  const trustedKeys = parseTrustedKeys(`registry:${key.publicX}`);
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plugins-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function write(
    slug: string,
    files: { manifest?: string; source?: string } = {},
    sign: { pem?: string; version?: string } | false = {},
  ): void {
    const dir = join(root, slug);
    mkdirSync(dir, { recursive: true });
    const m = files.manifest ?? manifest(slug);
    const s = files.source ?? source();
    writeFileSync(join(dir, 'plugin.json'), m);
    writeFileSync(join(dir, 'index.ts'), s);
    if (sign !== false) {
      const sig = signPlugin(
        { manifest: m, source: s },
        { slug, version: sign.version ?? '1.0.0', keyId: 'registry' },
        sign.pem ?? key.privatePem,
      );
      writeFileSync(join(dir, 'signature.json'), JSON.stringify(sig));
    }
  }

  function load(slugs: string[], extra: Partial<LoadPluginsOptions> = {}) {
    return loadPlugins({
      root,
      slugs,
      trustedKeys,
      allowUnsigned: false,
      nodeEnv: 'production',
      warn: jest.fn(),
      ...extra,
    });
  }

  it('loads a signed folder: manifest from plugin.json, handlers from index.ts', async () => {
    write('acme');

    const [plugin] = load(['acme']);

    expect(plugin).toMatchObject({ slug: 'acme', version: '1.0.0' });
    // `instanceof PluginError` must hold across the vm boundary, or every
    // refusal from a plugin would turn into a 502.
    await expect(
      Promise.resolve().then(() =>
        plugin.queries!.hello(
          {
            plugin: { slug: 'acme', version: '1.0.0' },
            installation: { id: 'i', config: {} },
          } as any,
          {},
        ),
      ),
    ).rejects.toBeInstanceOf(PluginError);
  });

  it('reads only the enabled slugs — a broken plugin that is off is never touched', () => {
    write('acme');
    write('broken', { source: 'this is not typescript {' }, false);
    expect(load(['acme'])).toHaveLength(1);
    expect(load([])).toEqual([]);
  });

  it('refuses code changed after signing, before running any of it', () => {
    write('acme');
    writeFileSync(
      join(root, 'acme', 'index.ts'),
      source('(globalThis as any).ran = true;'),
    );
    expect(() => load(['acme'])).toThrow(/index\.ts changed after signing/);
  });

  it('refuses a capability added after signing', () => {
    write('acme');
    writeFileSync(
      join(root, 'acme', 'plugin.json'),
      JSON.stringify({
        ...JSON.parse(manifest('acme')),
        capabilities: ['customers:write'],
      }),
    );
    expect(() => load(['acme'])).toThrow(/plugin\.json changed after signing/);
  });

  it('refuses a signer it does not trust', () => {
    write('acme', {}, { pem: generateSigningKey().privatePem });
    expect(() => load(['acme'])).toThrow(/does not verify/);
  });

  it('refuses a folder whose plugin.json names another slug', () => {
    write('acme', { manifest: manifest('other') });
    expect(() => load(['acme'])).toThrow(
      /says "other", but the folder is "acme"/,
    );
  });

  it('refuses a missing signature unless unsigned plugins are allowed outside production', () => {
    write('acme', {}, false);
    expect(() => load(['acme'])).toThrow(/signature\.json is missing/);

    const warn = jest.fn();
    expect(
      load(['acme'], { allowUnsigned: true, nodeEnv: 'development', warn }),
    ).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('UNSIGNED'));

    expect(() =>
      load(['acme'], { allowUnsigned: true, nodeEnv: 'production' }),
    ).toThrow(/refused when NODE_ENV=production/);
  });

  it('refuses a slug that could leave the folder, and one that is not there', () => {
    expect(() => load(['../etc'])).toThrow(/slug must match/);
    expect(() => load(['ghost'])).toThrow(/npm run plugins -- new ghost/);
  });
});

describe('parseManifest', () => {
  it('refuses unknown fields, so a typo is never silently ignored', () => {
    expect(() =>
      parseManifest(JSON.stringify({ slug: 'a', capabilites: [] })),
    ).toThrow(/unknown field\(s\): capabilites/);
  });

  it('refuses a manifest that is not a JSON object', () => {
    expect(() => parseManifest('[1]')).toThrow(/must be a JSON object/);
    expect(() => parseManifest('{')).toThrow(/not valid JSON/);
  });
});

describe('sandboxPluginSource — plugin code runs in an isolate', () => {
  const LIMITS = { timeoutMs: 500, memoryMb: 16 };

  /** A context whose every method records the call and answers null. */
  function hostContext(overrides: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        calls.push(name);
        void args;
        return Promise.resolve(null);
      };
    const ctx = {
      plugin: { slug: 'acme', version: '1.0.0' },
      installation: { id: 'inst_1', config: {} },
      storage: {
        get: record('storage.get'),
        put: record('storage.put'),
        delete: record('storage.delete'),
        list: record('storage.list'),
      },
      core: {
        customers: {
          list: record('c'),
          get: record('c'),
          create: record('c'),
          update: record('c'),
        },
        products: {
          list: record('p'),
          get: record('p'),
          create: record('p'),
          update: record('p'),
        },
        paymentIntents: { list: record('pi'), get: record('pi') },
      },
      http: { request: record('http') },
      log: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      ...overrides,
    } as any;
    return { ctx, calls };
  }

  function handlersOf(body: string, top = '') {
    return sandboxPluginSource(
      `import { defineHandlers, PluginError } from '@/plugins/sdk';
${top}
export default defineHandlers({ queries: { run: async (ctx: any, input: any) => { ${body} } } });
`,
      'index.ts',
      LIMITS,
    );
  }

  const run = (body: string, top = '', ctx = hostContext().ctx) =>
    handlersOf(body, top).queries!.run(ctx, {});

  it.each([
    [
      'import a Node module',
      `import { readFileSync } from 'node:fs'; void readFileSync;`,
    ],
    ['import an npm package', `import pg from 'pg'; void pg;`],
    ['import a relative file', `import x from './secrets'; void x;`],
    ['touch process at load', `(process as any).env;`],
    ['hang the load', `while (true) {}`],
  ])('refuses code that tries to %s', (_label, top) => {
    expect(() => handlersOf('return 1;', top)).toThrow();
  });

  it('finds nothing of this process to escape to', async () => {
    const found = await run(`
      const sdkFn: any = defineHandlers;
      return {
        process: typeof (globalThis as any).process,
        require: typeof (globalThis as any).require,
        bridge: typeof (globalThis as any).__cosmosBridge,
        viaSdkConstructor: sdkFn.constructor('return typeof process')(),
        viaFunction: new Function('return typeof process')(),
        viaEval: (0, eval)('typeof process'),
        viaCtx: (ctx.storage.get as any).constructor('return typeof process')(),
      };
    `);
    expect(found).toEqual({
      process: 'undefined',
      require: 'undefined',
      bridge: 'undefined',
      viaSdkConstructor: 'undefined',
      viaFunction: 'undefined',
      viaEval: 'undefined',
      viaCtx: 'undefined',
    });
  });

  it('stops a synchronous loop, without ever holding this event loop', async () => {
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 20);
    try {
      await expect(run('while (true) {}')).rejects.toBeInstanceOf(
        PluginTimeoutError,
      );
    } finally {
      clearInterval(ticker);
    }
    // The host kept running while the plugin spun.
    expect(ticks).toBeGreaterThan(5);
  });

  it('fails a plugin that exhausts its memory, alone', async () => {
    await expect(
      run('const a: string[] = []; while (true) a.push("x".repeat(1e6));'),
    ).rejects.toThrow(/sandbox|Plugin acme/);
  });

  it('keeps nothing between invocations — one tenant’s state never reaches another', async () => {
    const handlers = handlersOf(
      'seen.push(input.tenant); return seen;',
      'const seen: string[] = [];',
    );
    const { ctx } = hostContext();
    expect(await handlers.queries!.run(ctx, { tenant: 'a' })).toEqual(['a']);
    expect(await handlers.queries!.run(ctx, { tenant: 'b' })).toEqual(['b']);
  });

  it('turns a PluginError into the runtime’s own PluginError', async () => {
    await expect(run(`throw new PluginError('nope');`)).rejects.toBeInstanceOf(
      PluginError,
    );
  });

  it('fails the invocation on a violation even when the plugin swallows it', async () => {
    const { ctx } = hostContext({
      storage: {
        get: () => {
          throw new PluginViolationError('not granted');
        },
      },
    });
    await expect(
      run(
        `try { await ctx.storage.get('c', 'k'); } catch { /* hide it */ } return 'fine';`,
        '',
        ctx,
      ),
    ).rejects.toBeInstanceOf(PluginViolationError);
  });

  it('reaches the host only through the context methods', async () => {
    const { ctx, calls } = hostContext();
    await run(`await ctx.storage.put('c', 'k', 1); return null;`, '', ctx);
    expect(calls).toEqual(['storage.put']);
  });

  it('refuses metadata in index.ts: that belongs in plugin.json', () => {
    expect(() =>
      sandboxPluginSource(
        `export default { capabilities: ['customers:write'], queries: {} };`,
        'index.ts',
      ),
    ).toThrow(/belong in plugin\.json/);
  });

  it('refuses a file with no default export', () => {
    expect(() =>
      sandboxPluginSource('export const x = 1;', 'index.ts'),
    ).toThrow(/export default defineHandlers/);
  });
});
