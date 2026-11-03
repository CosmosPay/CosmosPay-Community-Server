import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { PluginSandbox, type SandboxLimits } from '@/plugins/plugin-sandbox';
import {
  verifyPluginSignature,
  type PluginFiles,
  type TrustedPluginKey,
} from '@/plugins/plugin-signature';
import {
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MANIFEST_MAX_BYTES,
  PLUGIN_SIGNATURE_FILE,
  PLUGIN_SLUG_RE,
  PLUGIN_SOURCE_FILE,
  PLUGIN_SOURCE_FORBIDDEN_CHARS_RE,
  PLUGIN_SOURCE_MAX_BYTES,
} from '@/plugins/plugins.constants';
import type {
  PluginDefinition,
  PluginHandlers,
  PluginManifest,
} from '@/plugins/sdk';

/**
 * Plugins as folders: `plugins/<slug>/plugin.json` + `index.ts` +
 * `signature.json`. Reading one, checking who vouches for it, and turning it
 * into a {@link PluginDefinition} the runtime can serve.
 */

export interface LoadPluginsOptions {
  /** The plugins folder, absolute. */
  root: string;
  /** The slugs to load — the enabled ones. Nothing else in the folder is read. */
  slugs: readonly string[];
  /** Support's keys plus the operator's PLUGINS_TRUSTED_KEYS. */
  trustedKeys: readonly TrustedPluginKey[];
  /** `PLUGINS_ALLOW_UNSIGNED`: for writing a plugin locally. */
  allowUnsigned: boolean;
  nodeEnv: string;
  /**
   * `STELLAR_NETWORK`, the deployment's default network. `public` means real
   * money, which refuses unsigned plugins as `NODE_ENV=production` does: a
   * deployment can run with `NODE_ENV` unset or `development` and still be the
   * one serving mainnet.
   */
  defaultNetwork: 'public' | 'testnet';
  /** Told about every unsigned plugin loaded, so it is never silent. */
  warn: (message: string) => void;
}

const MANIFEST_KEYS = new Set([
  'slug',
  'name',
  'version',
  'description',
  'author',
  'capabilities',
  'egress',
  'config',
]);

/**
 * Loads the enabled plugins from the plugins folder.
 *
 * A plugin runs because a trusted key signed exactly its `plugin.json` and
 * `index.ts` under exactly its slug and version — a Cosmos Pay support key (a
 * plugin support ships preinstalled) or one the operator listed. Every check
 * runs before a line of its code executes, and any failure throws, stopping the
 * boot: a deployment never half-loads its plugins, or runs one that could not
 * prove who vouches for it.
 *
 * Only enabled slugs are read. A plugin that sits in the folder disabled is
 * never parsed, compiled or evaluated — and an enabled one runs only inside a
 * V8 isolate (`plugin-sandbox.ts`), never in this process.
 */
export function loadPlugins(options: LoadPluginsOptions): PluginDefinition[] {
  if (options.slugs.length === 0) return [];
  if (
    options.allowUnsigned &&
    (options.nodeEnv === 'production' || options.defaultNetwork === 'public')
  ) {
    throw new Error(
      'PLUGINS_ALLOW_UNSIGNED=true is refused when NODE_ENV=production or ' +
        'STELLAR_NETWORK=public: an unsigned plugin is code nobody vouched for, ' +
        'running with tenant data',
    );
  }

  const errors: string[] = [];
  const loaded: PluginDefinition[] = [];
  for (const slug of options.slugs) {
    try {
      loaded.push(loadPlugin(options.root, slug, options));
    } catch (err) {
      errors.push(
        `plugin "${slug}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid plugins:\n  - ${errors.join('\n  - ')}`);
  }
  return loaded;
}

function loadPlugin(
  root: string,
  slug: string,
  options: Pick<LoadPluginsOptions, 'trustedKeys' | 'allowUnsigned' | 'warn'>,
): PluginDefinition {
  const { files, manifest } = readPluginFolder(root, slug);

  const signaturePath = join(root, slug, PLUGIN_SIGNATURE_FILE);
  if (existsSync(signaturePath)) {
    let signature: unknown;
    try {
      signature = JSON.parse(readFileSync(signaturePath, 'utf8'));
    } catch {
      throw new Error(`${PLUGIN_SIGNATURE_FILE} is not JSON`);
    }
    const problem = verifyPluginSignature(
      files,
      signature,
      options.trustedKeys,
      { slug, version: manifest.version },
    );
    if (problem) throw new Error(problem);
  } else if (options.allowUnsigned) {
    options.warn(
      `Loading UNSIGNED plugin "${slug}" (PLUGINS_ALLOW_UNSIGNED=true)`,
    );
  } else {
    throw new Error(
      `${PLUGIN_SIGNATURE_FILE} is missing. Sign it (npm run plugins -- sign), ` +
        'or set PLUGINS_ALLOW_UNSIGNED=true while developing it locally',
    );
  }

  const handlers = sandboxPluginSource(
    files.source,
    join(root, slug, PLUGIN_SOURCE_FILE),
  );
  return { ...manifest, ...handlers };
}

/**
 * Reads `plugin.json` and `index.ts` of one plugin, without running anything.
 * Exported for the CLI, which signs and verifies the same files.
 */
export function readPluginFolder(
  root: string,
  slug: string,
): { files: PluginFiles; manifest: PluginManifest } {
  // The slug becomes a path segment: it must not be able to leave the folder.
  if (!PLUGIN_SLUG_RE.test(slug)) {
    throw new Error(`slug must match ${PLUGIN_SLUG_RE}`);
  }
  const dir = join(root, slug);
  if (!existsSync(dir)) {
    throw new Error(
      `${dir} does not exist. Create it (npm run plugins -- new ${slug}) or install it (npm run plugins -- install ${slug})`,
    );
  }
  const manifestText = readBounded(
    join(dir, PLUGIN_MANIFEST_FILE),
    PLUGIN_MANIFEST_MAX_BYTES,
  );
  const source = readBounded(
    join(dir, PLUGIN_SOURCE_FILE),
    PLUGIN_SOURCE_MAX_BYTES,
  );
  assertReviewable(PLUGIN_MANIFEST_FILE, manifestText);
  assertReviewable(PLUGIN_SOURCE_FILE, source);
  const manifest = parseManifest(manifestText);
  if (manifest.slug !== slug) {
    throw new Error(
      `${PLUGIN_MANIFEST_FILE} says "${String(manifest.slug)}", but the folder is "${slug}"`,
    );
  }
  return { files: { manifest: manifestText, source }, manifest };
}

/**
 * Refuses a file whose text can read differently from how it runs: a
 * bidirectional control (Trojan Source) or an invisible character anywhere
 * but a leading byte-order mark. A signature says a person reviewed the file,
 * so what they saw must be what loads. Exported for `npm run plugins -- install`,
 * which checks what a registry served before writing it.
 */
export function assertReviewable(name: string, text: string): void {
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const match = PLUGIN_SOURCE_FORBIDDEN_CHARS_RE.exec(body);
  if (!match) return;
  const before = body.slice(0, match.index);
  const line = before.split('\n').length;
  const code = match[0].codePointAt(0)!.toString(16).toUpperCase();
  throw new Error(
    `${name} line ${line} contains U+${code.padStart(4, '0')}, an invisible, control or ` +
      'bidirectional character: what a reviewer reads would not be what runs',
  );
}

/**
 * The first key an object of this JSON text lists twice, or null. `JSON.parse`
 * keeps the LAST one silently, so a manifest with `"egress": []` near the top
 * and `"egress": ["evil.example"]` further down reads as no network to a
 * reviewer and loads with one. The text is valid JSON when this runs.
 */
export function duplicateJsonKey(text: string): string | null {
  const objects: (Set<string> | null)[] = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const keys = objects[objects.length - 1];
      if (keys && expectKey) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (keys.has(key)) return key;
        keys.add(key);
        expectKey = false;
      }
      i = end;
    } else if (ch === '{') {
      objects.push(new Set());
      expectKey = true;
    } else if (ch === '[') {
      objects.push(null);
      expectKey = false;
    } else if (ch === '}' || ch === ']') {
      objects.pop();
      expectKey = false;
    } else if (ch === ',') {
      expectKey = objects[objects.length - 1] instanceof Set;
    }
  }
  return null;
}

function readBounded(path: string, maxBytes: number): string {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  if (statSync(path).size > maxBytes) {
    throw new Error(`${path} exceeds ${maxBytes} bytes`);
  }
  return readFileSync(path, 'utf8');
}

/**
 * `plugin.json` → {@link PluginManifest}. Unknown fields are refused: a typo in
 * `capabilites` silently ignored would be a plugin its reviewer misread.
 * The values themselves are checked by `validatePluginDefinition` at boot.
 */
export function parseManifest(text: string): PluginManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${PLUGIN_MANIFEST_FILE} is not valid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${PLUGIN_MANIFEST_FILE} must be a JSON object`);
  }
  const twice = duplicateJsonKey(text);
  if (twice !== null) {
    throw new Error(
      `${PLUGIN_MANIFEST_FILE} lists "${twice}" twice in one object: a reviewer ` +
        'reads the first, the loader keeps the last',
    );
  }
  const unknown = Object.keys(value).filter((k) => !MANIFEST_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `${PLUGIN_MANIFEST_FILE} has unknown field(s): ${unknown.join(', ')}`,
    );
  }
  const manifest = value as PluginManifest;
  if (!Array.isArray(manifest.capabilities)) {
    throw new Error(`${PLUGIN_MANIFEST_FILE}: capabilities must be an array`);
  }
  return manifest;
}

/** `index.ts` → CommonJS. Transpile-only: `tsc` type-checks `plugins/` in CI. */
export function compilePluginSource(source: string, fileName: string): string {
  const { outputText, diagnostics } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
    fileName,
  });
  if (diagnostics?.length) {
    throw new Error(
      diagnostics
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
        .join('\n'),
    );
  }
  return outputText;
}

/**
 * Compiles a plugin's `index.ts`, loads it once in an isolate to read what it
 * exports, and returns the handlers the runtime calls — each of which runs the
 * plugin in a fresh isolate of its own (`plugin-sandbox.ts`). No plugin code
 * ever runs in this process.
 */
export function sandboxPluginSource(
  source: string,
  fileName: string,
  limits?: SandboxLimits,
): PluginHandlers {
  const sandbox = new PluginSandbox(
    compilePluginSource(source, fileName),
    fileName,
    limits,
  );
  return sandbox.handlers(sandbox.describe());
}
