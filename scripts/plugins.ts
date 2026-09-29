import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  evaluatePluginSource,
  parseManifest,
  readPluginFolder,
} from '@/plugins/plugin-folder';
import { validatePluginDefinition } from '@/plugins/plugin-manifest';
import {
  generateSigningKey,
  parseTrustedKeys,
  signPlugin,
  supportKeys,
  verifyPluginSignature,
  type PluginSignatureFile,
} from '@/plugins/plugin-signature';
import {
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MANIFEST_MAX_BYTES,
  PLUGIN_SIGNATURE_FILE,
  PLUGIN_SLUG_RE,
  PLUGIN_SOURCE_FILE,
  PLUGIN_SOURCE_MAX_BYTES,
  PLUGIN_VERSION_RE,
  PLUGINS_FOLDER,
} from '@/plugins/plugins.constants';

/**
 * Everything about plugin folders, from the first file to a deployment:
 *
 *   npm run plugins -- new my-plugin                  create plugins/my-plugin/ from a template
 *   npm run plugins -- check my-plugin                validate it without signing (runs its top level)
 *   npm run plugins -- sign my-plugin --key k.pem --key-id cosmos-support
 *   npm run plugins -- verify my-plugin               is it signed by a key this deployment trusts?
 *   npm run plugins -- keygen --out k.pem --key-id my-registry
 *   npm run plugins -- publish my-plugin --registry-dir registry/
 *   npm run plugins -- install my-plugin[@1.0.0] [--registry https://…]
 *
 * Every plugin lives in ONE folder, `plugins/` at the repository root. A plugin
 * is three readable files — plugin.json, index.ts, signature.json — and nothing
 * is compiled or packed ahead of time.
 *
 * A registry is any static HTTPS host serving the folder `publish` builds:
 *
 *   index.json                    { "plugins": { "<slug>": { "latest": "1.0.0", "versions": {
 *                                     "1.0.0": { "manifest": "…", "source": "…", "signature": "…" } } } } }
 *   <slug>/<version>/plugin.json, index.ts, signature.json
 *
 * The registry is not trusted: `install` verifies the signature (support's
 * keys, plus PLUGINS_TRUSTED_KEYS) before writing anything, and the server
 * verifies it again at every boot. A compromised host can withhold plugins,
 * not forge them.
 */

const ROOT = resolve(PLUGINS_FOLDER);

type Flags = Record<string, string>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value`);
      }
      flags[arg.slice(2)] = value;
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new Error(`missing ${what}`);
  return value;
}

/** The signers a deployment accepts: support's, plus the operator's. */
function trustedKeys(flags: Flags) {
  const raw = flags['trusted-keys'] ?? process.env.PLUGINS_TRUSTED_KEYS ?? '';
  return [...supportKeys(), ...parseTrustedKeys(raw)];
}

/** Reads, compiles, runs the top level and validates one plugin — no signature. */
function checkPlugin(slug: string) {
  const { files, manifest } = readPluginFolder(ROOT, slug);
  const handlers = evaluatePluginSource(
    files.source,
    join(ROOT, slug, PLUGIN_SOURCE_FILE),
  );
  const errors = validatePluginDefinition({ ...manifest, ...handlers });
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return { files, manifest, handlers };
}

// ── new ──────────────────────────────────────────────────────────────────────

function newPlugin(positional: string[]): void {
  const slug = need(positional[0], '<slug>');
  if (!PLUGIN_SLUG_RE.test(slug)) {
    throw new Error(`the slug must match ${PLUGIN_SLUG_RE} (e.g. my-plugin)`);
  }
  const dir = join(ROOT, slug);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  mkdirSync(dir, { recursive: true });

  const manifest = {
    slug,
    name: slug
      .split('-')
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' '),
    version: '0.1.0',
    description: 'What this plugin does, in one sentence.',
    author: 'Your name or team',
    capabilities: ['customers:read'],
    egress: [],
    config: {},
  };
  writeFileSync(
    join(dir, PLUGIN_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, PLUGIN_SOURCE_FILE),
    [
      '/**',
      ` * ${manifest.name}. See plugins/example/ for a plugin that uses every part of`,
      ' * the SDK, and src/plugins/sdk.ts for the whole surface.',
      ' */',
      "import { defineHandlers, requireString } from '@/plugins/sdk';",
      '',
      'export default defineHandlers({',
      '  queries: {',
      `    // POST /v1/plugins/${slug}/queries/hello  { "input": { "customerId": "…" } }`,
      '    hello: async (ctx, input) => {',
      "      const customerId = requireString(input, 'customerId', { max: 64 });",
      '      const customer = await ctx.core.customers.get(customerId);',
      "      return { greeting: customer ? `Hello, ${customer.name}` : 'Not found' };",
      '    },',
      '  },',
      '});',
      '',
    ].join('\n'),
  );
  console.log(`Created ${dir}`);
  console.log('Next:');
  console.log(
    `  1. edit ${PLUGIN_MANIFEST_FILE} (what it may touch) and ${PLUGIN_SOURCE_FILE} (what it does)`,
  );
  console.log(`  2. npm run plugins -- check ${slug}`);
  console.log(
    `  3. run it locally: PLUGINS_ENABLED=${slug} PLUGINS_ALLOW_UNSIGNED=true npm run start:dev`,
  );
  console.log(
    '  4. open a PR; support signs it (npm run plugins -- sign) once reviewed',
  );
}

// ── check / sign / verify / keygen ───────────────────────────────────────────

function check(positional: string[]): void {
  const slug = need(positional[0], '<slug>');
  const { manifest, handlers } = checkPlugin(slug);
  const count = (o?: object) => Object.keys(o ?? {}).length;
  console.log(
    `OK: ${slug}@${manifest.version} — ${count(handlers.queries)} queries, ` +
      `${count(handlers.commands)} commands, ${count(handlers.events)} events; ` +
      `capabilities: ${manifest.capabilities.join(', ') || '(none)'}`,
  );
}

function sign(positional: string[], flags: Flags): void {
  const slug = need(positional[0], '<slug>');
  const keyFile = need(flags.key, '--key <private key file>');
  const keyId = need(flags['key-id'], '--key-id <id>');
  const { files, manifest } = checkPlugin(slug);
  const signature = signPlugin(
    files,
    { slug, version: manifest.version, keyId },
    readFileSync(keyFile, 'utf8'),
  );
  writeFileSync(
    join(ROOT, slug, PLUGIN_SIGNATURE_FILE),
    `${JSON.stringify(signature, null, 2)}\n`,
  );
  console.log(`Signed ${slug}@${manifest.version} with "${keyId}"`);
}

function verifyCommand(positional: string[], flags: Flags): void {
  const slug = need(positional[0], '<slug>');
  const { files, manifest } = readPluginFolder(ROOT, slug);
  const signature = JSON.parse(
    readFileSync(join(ROOT, slug, PLUGIN_SIGNATURE_FILE), 'utf8'),
  ) as PluginSignatureFile;
  const problem = verifyPluginSignature(files, signature, trustedKeys(flags), {
    slug,
    version: manifest.version,
  });
  if (problem) throw new Error(problem);
  console.log(
    `OK: ${slug}@${manifest.version}, signed by "${signature.keyId}"`,
  );
}

function keygen(flags: Flags): void {
  const out = need(flags.out, '--out <private key file>');
  const keyId = flags['key-id'] ?? 'plugins';
  if (existsSync(out)) {
    throw new Error(`${out} exists; refusing to overwrite a key`);
  }
  const { privatePem, publicX } = generateSigningKey();
  writeFileSync(out, privatePem, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(
    `Private key written to ${out} — keep it out of every repository.`,
  );
  console.log('Trust it on a deployment with:');
  console.log(`  PLUGINS_TRUSTED_KEYS=${keyId}:${publicX}`);
}

// ── publish / install ────────────────────────────────────────────────────────

interface RegistryEntry {
  manifest: string;
  source: string;
  signature: string;
}

interface RegistryIndex {
  plugins: Record<
    string,
    { latest: string; versions: Record<string, RegistryEntry> }
  >;
}

function publish(positional: string[], flags: Flags): void {
  const slug = need(positional[0], '<slug>');
  const registry = need(flags['registry-dir'], '--registry-dir <directory>');
  verifyCommand([slug], flags);
  const { manifest } = readPluginFolder(ROOT, slug);
  const target = join(registry, slug, manifest.version);
  if (existsSync(target)) {
    throw new Error(
      `${slug}@${manifest.version} is already published; bump the version`,
    );
  }
  mkdirSync(target, { recursive: true });
  for (const file of [
    PLUGIN_MANIFEST_FILE,
    PLUGIN_SOURCE_FILE,
    PLUGIN_SIGNATURE_FILE,
  ]) {
    cpSync(join(ROOT, slug, file), join(target, file));
  }

  const indexPath = join(registry, 'index.json');
  const index: RegistryIndex = existsSync(indexPath)
    ? (JSON.parse(readFileSync(indexPath, 'utf8')) as RegistryIndex)
    : { plugins: {} };
  const entry = (index.plugins[slug] ??= {
    latest: manifest.version,
    versions: {},
  });
  const base = `${slug}/${manifest.version}`;
  entry.versions[manifest.version] = {
    manifest: `${base}/${PLUGIN_MANIFEST_FILE}`,
    source: `${base}/${PLUGIN_SOURCE_FILE}`,
    signature: `${base}/${PLUGIN_SIGNATURE_FILE}`,
  };
  entry.latest = manifest.version;
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`Published ${slug}@${manifest.version} to ${registry}`);
}

async function fetchText(url: URL, maxBytes: number): Promise<string> {
  if (url.protocol !== 'https:') {
    throw new Error(`${url.href}: only https registries`);
  }
  const res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${url.href}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw new Error(`${url.href}: larger than ${maxBytes} bytes`);
  }
  return bytes.toString('utf8');
}

async function install(positional: string[], flags: Flags): Promise<void> {
  const [slug, pinned] = need(positional[0], '<slug>[@version]').split('@');
  if (!PLUGIN_SLUG_RE.test(slug)) {
    throw new Error(`slug must match ${PLUGIN_SLUG_RE}`);
  }
  if (pinned !== undefined && !PLUGIN_VERSION_RE.test(pinned)) {
    throw new Error('version must be semver');
  }
  const registry = need(
    flags.registry ?? process.env.PLUGINS_REGISTRY_URL,
    '--registry <https url> (or PLUGINS_REGISTRY_URL)',
  );
  const keys = trustedKeys(flags);
  const base = new URL(registry.endsWith('/') ? registry : `${registry}/`);

  const index = JSON.parse(
    await fetchText(new URL('index.json', base), 1024 * 1024),
  ) as RegistryIndex;
  const entry = index.plugins?.[slug];
  if (!entry) throw new Error(`the registry has no plugin "${slug}"`);
  const version = pinned ?? entry.latest;
  const files = entry.versions?.[version];
  if (!files) throw new Error(`the registry has no ${slug}@${version}`);

  const manifestText = await fetchText(
    new URL(files.manifest, base),
    PLUGIN_MANIFEST_MAX_BYTES,
  );
  const source = await fetchText(
    new URL(files.source, base),
    PLUGIN_SOURCE_MAX_BYTES,
  );
  const signatureText = await fetchText(
    new URL(files.signature, base),
    64 * 1024,
  );

  // Everything is checked before a byte lands in plugins/.
  const manifest = parseManifest(manifestText);
  if (manifest.slug !== slug || manifest.version !== version) {
    throw new Error(`the registry served ${manifest.slug}@${manifest.version}`);
  }
  const signature = JSON.parse(signatureText) as PluginSignatureFile;
  const problem = verifyPluginSignature(
    { manifest: manifestText, source },
    signature,
    keys,
    { slug, version },
  );
  if (problem) throw new Error(problem);
  const errors = validatePluginDefinition({
    ...manifest,
    ...evaluatePluginSource(source, `${slug}/${PLUGIN_SOURCE_FILE}`),
  });
  if (errors.length > 0) throw new Error(errors.join('\n'));

  // Write beside the target and swap, so a crash never leaves half a plugin.
  const target = join(ROOT, slug);
  const staging = join(ROOT, `.${slug}.installing`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, PLUGIN_MANIFEST_FILE), manifestText);
  writeFileSync(join(staging, PLUGIN_SOURCE_FILE), source);
  writeFileSync(join(staging, PLUGIN_SIGNATURE_FILE), signatureText);
  const replaced = existsSync(target);
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);

  console.log(
    `${replaced ? 'Updated' : 'Installed'} ${slug}@${version} in ${target}, signed by "${signature.keyId}".`,
  );
  console.log(
    `Serve it by adding "${slug}" to PLUGINS_ENABLED and restarting.`,
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case 'new':
      return newPlugin(positional);
    case 'check':
      return check(positional);
    case 'sign':
      return sign(positional, flags);
    case 'verify':
      return verifyCommand(positional, flags);
    case 'keygen':
      return keygen(flags);
    case 'publish':
      return publish(positional, flags);
    case 'install':
      return install(positional, flags);
    default:
      throw new Error(
        'usage: npm run plugins -- <new|check|sign|verify|keygen|publish|install> …',
      );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
