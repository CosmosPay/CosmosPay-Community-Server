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
  if (options.allowUnsigned && options.nodeEnv === 'production') {
    throw new Error(
      'PLUGINS_ALLOW_UNSIGNED=true is refused when NODE_ENV=production: an ' +
        'unsigned plugin is code nobody vouched for, running with tenant data',
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
      `${PLUGIN_SIGNATURE_FILE} is missing — sign it (npm run plugins -- sign), ` +
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
      `${dir} does not exist — create it (npm run plugins -- new ${slug}) or install it (npm run plugins -- install ${slug})`,
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
  const manifest = parseManifest(manifestText);
  if (manifest.slug !== slug) {
    throw new Error(
      `${PLUGIN_MANIFEST_FILE} says "${String(manifest.slug)}", but the folder is "${slug}"`,
    );
  }
  return { files: { manifest: manifestText, source }, manifest };
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
