import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  PLUGIN_KEY_ID_RE,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_SIGNATURE_FORMAT,
  PLUGIN_SOURCE_FILE,
  PLUGIN_SUPPORT_KEYS,
} from '@/plugins/plugins.constants';

/**
 * Signatures over plugin folders — what lets a deployment run plugin code that
 * did not come from its own build.
 *
 * What is signed is the two files a person reads — `plugin.json` and
 * `index.ts` — bound to the plugin's slug and version. So the review and the
 * signature cover the same thing, and a signature cannot be moved to other code,
 * or to the same code under another name or an older version.
 *
 * The hashes are over the files' MEANING, not their bytes, where the two can
 * differ without the plugin changing: `plugin.json` is hashed as canonical JSON
 * (formatting is free), `index.ts` with its line endings normalized (a Windows
 * checkout is not a different plugin). Anything else — one character of code,
 * one capability — is a different hash.
 *
 * Ed25519, because it has no parameters to get wrong and a public key fits on
 * one line of an environment variable.
 */

/** The contents of a plugin folder that a signature covers. */
export interface PluginFiles {
  manifest: string;
  source: string;
}

/** `signature.json`, as `npm run plugins -- sign` writes it. */
export interface PluginSignatureFile {
  format: typeof PLUGIN_SIGNATURE_FORMAT;
  slug: string;
  version: string;
  /** SHA-256 (hex) per file — which one changed is readable at a glance. */
  files: Record<string, string>;
  keyId: string;
  /** Base64url Ed25519 signature over {@link signedPayload}. */
  signature: string;
}

export interface TrustedPluginKey {
  id: string;
  key: KeyObject;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Canonical JSON: keys sorted at every level, no whitespace. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The per-file hashes a signature is over. Throws if `plugin.json` is not JSON. */
export function hashPluginFiles(files: PluginFiles): Record<string, string> {
  return {
    [PLUGIN_MANIFEST_FILE]: sha256Hex(
      canonicalJson(JSON.parse(files.manifest) as unknown),
    ),
    [PLUGIN_SOURCE_FILE]: sha256Hex(files.source.replace(/\r\n/g, '\n')),
  };
}

/** The exact bytes signed: an array, so no field can bleed into the next. */
function signedPayload(
  slug: string,
  version: string,
  files: Record<string, string>,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      PLUGIN_SIGNATURE_FORMAT,
      slug,
      version,
      Object.keys(files)
        .sort()
        .map((name) => [name, files[name]]),
    ]),
    'utf8',
  );
}

/**
 * `PLUGINS_TRUSTED_KEYS`: comma-separated `<keyId>:<base64url public key>`,
 * the key being the raw 32 bytes `npm run plugins -- keygen` prints.
 */
export function parseTrustedKeys(raw: string): TrustedPluginKey[] {
  const keys: TrustedPluginKey[] = [];
  const seen = new Set<string>();
  for (const entry of raw
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const [id, x, ...rest] = entry.split(':');
    if (!id || !x || rest.length > 0 || !PLUGIN_KEY_ID_RE.test(id)) {
      throw new Error(
        `PLUGINS_TRUSTED_KEYS entry "${entry}" must be <keyId>:<base64url public key>`,
      );
    }
    if (seen.has(id)) {
      throw new Error(`PLUGINS_TRUSTED_KEYS lists key "${id}" twice`);
    }
    seen.add(id);
    keys.push({ id, key: publicKeyFromRaw(x) });
  }
  return keys;
}

/** Cosmos Pay support's signers, trusted on every deployment. */
export function supportKeys(): TrustedPluginKey[] {
  return parseTrustedKeys(PLUGIN_SUPPORT_KEYS.join(','));
}

function publicKeyFromRaw(x: string): KeyObject {
  if (Buffer.from(x, 'base64url').length !== 32) {
    throw new Error(
      'A plugin signing public key is the 32-byte Ed25519 key, base64url',
    );
  }
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x },
    format: 'jwk',
  });
}

/**
 * Why the folder may not be trusted, or null when `file` is a valid signature
 * of exactly these files, by one of `trusted`, for this slug and version.
 */
export function verifyPluginSignature(
  files: PluginFiles,
  file: unknown,
  trusted: readonly TrustedPluginKey[],
  expected: { slug: string; version: string },
): string | null {
  if (!isSignatureFile(file)) {
    return `${PLUGIN_SIGNATURE_FORMAT} signature file is malformed`;
  }
  if (file.slug !== expected.slug || file.version !== expected.version) {
    return `signature is for ${file.slug}@${file.version}, not ${expected.slug}@${expected.version}`;
  }
  let actual: Record<string, string>;
  try {
    actual = hashPluginFiles(files);
  } catch {
    return `${PLUGIN_MANIFEST_FILE} is not JSON`;
  }
  const changed = Object.keys(actual).filter(
    (name) => actual[name] !== file.files[name],
  );
  if (changed.length > 0) {
    return `${changed.join(' and ')} changed after signing`;
  }
  const key = trusted.find((k) => k.id === file.keyId);
  if (!key) {
    return `signed with key "${file.keyId}", which is neither a support key nor in PLUGINS_TRUSTED_KEYS`;
  }
  const ok = verify(
    null,
    signedPayload(file.slug, file.version, actual),
    key.key,
    Buffer.from(file.signature, 'base64url'),
  );
  return ok ? null : `signature does not verify with key "${file.keyId}"`;
}

function isSignatureFile(file: unknown): file is PluginSignatureFile {
  if (!file || typeof file !== 'object') return false;
  const f = file as Record<string, unknown>;
  return (
    f.format === PLUGIN_SIGNATURE_FORMAT &&
    ['slug', 'version', 'keyId', 'signature'].every(
      (k) => typeof f[k] === 'string' && f[k] !== '',
    ) &&
    !!f.files &&
    typeof f.files === 'object' &&
    Object.values(f.files).every(
      (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h),
    )
  );
}

// ── The signing side (CLI) ────────────────────────────────────────────────────

/** A new signing key pair: a PKCS#8 PEM to keep secret, a public key to publish. */
export function generateSigningKey(): { privatePem: string; publicX: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicX: jwk.x as string,
  };
}

export function signPlugin(
  files: PluginFiles,
  meta: { slug: string; version: string; keyId: string },
  privatePem: string,
): PluginSignatureFile {
  if (!PLUGIN_KEY_ID_RE.test(meta.keyId)) {
    throw new Error(`keyId must match ${PLUGIN_KEY_ID_RE}`);
  }
  const hashes = hashPluginFiles(files);
  const signature = sign(
    null,
    signedPayload(meta.slug, meta.version, hashes),
    createPrivateKey(privatePem),
  ).toString('base64url');
  return {
    format: PLUGIN_SIGNATURE_FORMAT,
    slug: meta.slug,
    version: meta.version,
    files: hashes,
    keyId: meta.keyId,
    signature,
  };
}
