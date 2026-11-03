import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  duplicateJsonKey,
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
import { PLUGIN_MAX_CONCURRENT_CALLS_PER_INVOCATION } from '@/plugins/plugins.constants';
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
      defaultNetwork: 'testnet',
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

  it('refuses unsigned plugins on a deployment that serves mainnet, whatever NODE_ENV says', () => {
    write('acme', {}, false);
    expect(() =>
      load(['acme'], {
        allowUnsigned: true,
        nodeEnv: 'development',
        defaultNetwork: 'public',
      }),
    ).toThrow(/STELLAR_NETWORK=public/);
  });

  it('refuses a manifest that lists a key twice, before checking the signature', () => {
    const twice =
      '{"slug":"acme","name":"Acme","version":"1.0.0","description":"d",' +
      '"author":"a","capabilities":[],"egress":[],"egress":["evil.example.com"]}';
    write('acme', { manifest: twice });
    expect(() => load(['acme'])).toThrow(/lists "egress" twice/);
  });

  it.each([
    ['a right-to-left override in index.ts', 'index.ts', '\u202E'],
    ['a zero-width space in index.ts', 'index.ts', '\u200B'],
    ['a byte-order mark inside index.ts', 'index.ts', '\uFEFF'],
    ['a soft hyphen', 'index.ts', String.fromCodePoint(0xad)],
    ['a variation selector', 'index.ts', String.fromCodePoint(0xfe0f)],
    ['an astral tag character', 'index.ts', String.fromCodePoint(0xe0001)],
    ['a Hangul filler', 'index.ts', String.fromCodePoint(0x3164)],
    ['a NUL', 'index.ts', String.fromCodePoint(0)],
  ])('refuses %s: what review reads must be what runs', (_l, file, char) => {
    write('acme', { source: source(`// is admin${char} */`) });
    expect(() => load(['acme'])).toThrow(
      new RegExp(`${file.replace('.', '\\.')} line \\d+ contains U\\+`),
    );
  });

  it.each([
    ['U+2028', String.fromCodePoint(0x2028)],
    ['U+2029', String.fromCodePoint(0x2029)],
    ['a CR with no LF after it', '\r'],
  ])(
    'refuses %s, which ends a // comment for JavaScript but not on screen',
    (_l, terminator) => {
      // Shown as one comment line; run, the call after the terminator executes.
      write('acme', {
        source: source(
          `// harmless note${terminator}(globalThis as any).ran = true;`,
        ),
      });
      expect(() => load(['acme'])).toThrow(/index\.ts line \d+ contains U\+/);
    },
  );

  it('accepts CRLF line endings', () => {
    write('acme', { source: source().replace(/\n/g, '\r\n') });
    expect(load(['acme'])).toHaveLength(1);
  });

  it('refuses an invisible character in plugin.json', () => {
    write('acme', {
      manifest: manifest('acme').replace('"Acme"', '"Ac\u200Dme"'),
    });
    expect(() => load(['acme'])).toThrow(
      /plugin\.json line 1 contains U\+200D/,
    );
  });

  it('accepts a byte-order mark at the very start of a file', () => {
    write('acme', { source: `\uFEFF${source()}` });
    expect(load(['acme'])).toHaveLength(1);
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

describe('duplicateJsonKey', () => {
  it.each([
    ['{"a":1,"b":2}', null],
    ['{"a":{"a":1},"b":[{"a":1},{"a":2}]}', null],
    ['{"a":"\\"a\\"","b":"a"}', null],
    ['{"a":1,"a":2}', 'a'],
    ['{"o":{"x":1,"x":2}}', 'x'],
    ['{"l":[{"k":1,"k":2}]}', 'k'],
    // The same key spelled two ways is the same key to JSON.parse.
    ['{"egress":[],"\\u0065gress":["x"]}', 'egress'],
  ])('%s → %s', (text, expected) => {
    expect(duplicateJsonKey(text)).toBe(expected);
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
        compareAndSet: record('storage.compareAndSet'),
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

  it('hands compareAndSet the expected value and the new one, and its answer back', async () => {
    const seen: unknown[] = [];
    const { ctx } = hostContext({
      storage: {
        compareAndSet: (...args: unknown[]) => {
          seen.push(args);
          return Promise.resolve(false);
        },
      },
    });
    const won = await run(
      `return await ctx.storage.compareAndSet('c', 'k', { v: 1 }, { v: 2 });`,
      '',
      ctx,
    );
    expect(won).toBe(false);
    expect(seen).toEqual([['c', 'k', { v: 1 }, { v: 2 }]]);
  });

  it('runs the top level on the isolate thread, never holding this event loop', async () => {
    // 400 ms of synchronous work at the top level: inside the eval budget, so
    // it loads, and it runs again on every invocation.
    const handlers = sandboxPluginSource(
      `import { defineHandlers } from '@/plugins/sdk';
const until = Date.now() + 400;
while (Date.now() < until) { /* spin */ }
export default defineHandlers({ queries: { run: () => 1 } });
`,
      'index.ts',
      { timeoutMs: 5_000, memoryMb: 16 },
    );
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 20);
    try {
      await expect(handlers.queries!.run(hostContext().ctx, {})).resolves.toBe(
        1,
      );
    } finally {
      clearInterval(ticker);
    }
    expect(ticks).toBeGreaterThan(5);
  });

  it('ignores transfer options a plugin plants on Object.prototype', async () => {
    // isolated-vm reads its options through the prototype chain; had the
    // bridge's options been ordinary objects, these would have reached them.
    const { ctx } = hostContext({
      storage: { get: () => Promise.resolve({ secret: 'v' }) },
    });
    const found = await run(
      `
      const proto: any = Object.prototype;
      proto.reference = true;
      proto.externalCopy = true;
      const value: any = await ctx.storage.get('c', 'k');
      return {
        type: typeof value,
        plain: Object.getPrototypeOf(value) === Object.prototype,
        secret: value.secret,
      };
    `,
      '',
      ctx,
    );
    expect(found).toEqual({ type: 'object', plain: true, secret: 'v' });
  });

  it('lets one invocation have only a few context calls in flight at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const { ctx } = hostContext({
      storage: {
        get: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight -= 1;
          return null;
        },
      },
    });
    await run(
      `await Promise.all(Array.from({ length: 20 }, (_, i) => ctx.storage.get('c', 'k' + i)));
       return null;`,
      '',
      ctx,
    );
    expect(peak).toBe(PLUGIN_MAX_CONCURRENT_CALLS_PER_INVOCATION);
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
