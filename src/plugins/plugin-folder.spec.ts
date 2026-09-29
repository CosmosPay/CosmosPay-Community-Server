import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluatePluginSource,
  loadPlugins,
  parseManifest,
  type LoadPluginsOptions,
} from '@/plugins/plugin-folder';
import {
  generateSigningKey,
  parseTrustedKeys,
  signPlugin,
} from '@/plugins/plugin-signature';
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
      Promise.resolve().then(() => plugin.queries!.hello({} as any, {})),
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

describe('evaluatePluginSource', () => {
  it.each([
    [
      'import a Node module',
      `import { readFileSync } from 'node:fs'; void readFileSync;`,
    ],
    ['import an npm package', `import pg from 'pg'; void pg;`],
    ['import a relative file', `import x from './secrets'; void x;`],
    ['touch process', `(process as any).env;`],
    ['use eval', `eval('1');`],
    ['build a function from a string', `new Function('return 1')();`],
    ['hang the boot', `while (true) {}`],
  ])('refuses code that tries to %s', (_label, extra) => {
    expect(() => evaluatePluginSource(source(extra), 'index.ts')).toThrow();
  });

  it('refuses metadata in index.ts: that belongs in plugin.json', () => {
    expect(() =>
      evaluatePluginSource(
        `export default { capabilities: ['customers:write'], queries: {} };`,
        'index.ts',
      ),
    ).toThrow(/belong in plugin\.json/);
  });

  it('refuses a file with no default export', () => {
    expect(() =>
      evaluatePluginSource('export const x = 1;', 'index.ts'),
    ).toThrow(/export default defineHandlers/);
  });
});
