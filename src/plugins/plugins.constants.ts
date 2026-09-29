import type { RateLimitPolicy } from '@/common/decorators/rate-limit.decorator';

/**
 * Limits the plugin runtime puts around every piece of plugin code.
 *
 * A plugin runs inside this process, so none of these is a sandbox: they bound
 * how much of the core a plugin can spend by accident — the database, the event
 * loop, a tenant's quota — and they turn a plugin that misbehaves into a failed
 * request instead of a degraded service.
 */

/**
 * A plugin slug: the name its routes, its scopes in the logs and its rows are
 * filed under. Lowercase kebab-case, starting with a letter, so it is safe in a
 * URL path segment, a log prefix and a sealed-box purpose without escaping.
 */
export const PLUGIN_SLUG_RE = /^[a-z][a-z0-9-]{2,39}$/;

/** An action name inside a plugin: same alphabet as the slug. */
export const PLUGIN_ACTION_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** A config field name: a JS identifier, so it reads naturally in the handler. */
export const PLUGIN_CONFIG_FIELD_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** A storage collection. Chosen by the plugin; namespaced under its installation. */
export const PLUGIN_COLLECTION_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * A storage key. Wide enough for a core id (`cuid`), an email or a composite
 * `a:b`, narrow enough that it is never a path, a query or a newline in a log.
 */
export const PLUGIN_KEY_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;

/**
 * Semver `MAJOR.MINOR.PATCH`, optionally with a pre-release tag. Recorded on the
 * installation so a tenant can see which version they consented to.
 */
export const PLUGIN_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * An egress host: a DNS name, lowercase, at least one dot. No IP literals and no
 * wildcards — an allowlist entry is a promise about one party, and `*.com` or
 * `10.0.0.1` promise nothing.
 */
export const PLUGIN_EGRESS_HOST_RE =
  /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Wall-clock budget for one action or one event handler. When it runs out the
 * caller gets `504 plugin_failed`, the plugin's context is revoked, and its
 * isolate is disposed — which stops the plugin wherever it is, a synchronous
 * loop included.
 */
export const PLUGIN_INVOCATION_TIMEOUT_MS = 10_000;

/**
 * Context calls (storage, core, http) one invocation may make. A plugin that
 * loops over `storage.put` is a bug; this makes it a bounded bug.
 */
export const PLUGIN_MAX_CALLS_PER_INVOCATION = 200;

/** Size of the JSON `input` an action accepts, serialized. */
export const PLUGIN_MAX_INPUT_BYTES = 64 * 1024;

/** Size of the JSON an action may return, serialized. */
export const PLUGIN_MAX_OUTPUT_BYTES = 256 * 1024;

/** Size of one stored value, serialized. */
export const PLUGIN_MAX_VALUE_BYTES = 16 * 1024;

/**
 * Records one installation may hold across all its collections. With the value
 * cap this bounds a tenant's plugin data at ~160 MB, worst case, per plugin.
 */
export const PLUGIN_MAX_RECORDS_PER_INSTALLATION = 10_000;

/** Page size ceiling for `storage.list` and the core list reads. */
export const PLUGIN_MAX_PAGE_SIZE = 100;

/** Outbound HTTP: connect + read budget for one request. */
export const PLUGIN_HTTP_TIMEOUT_MS = 8_000;

/** Outbound HTTP: response bodies past this are cut off and the call fails. */
export const PLUGIN_HTTP_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Outbound HTTP: request body cap. */
export const PLUGIN_HTTP_MAX_REQUEST_BYTES = 256 * 1024;

/**
 * Headers a plugin may not set on an outbound request. The transport owns the
 * framing (`host`, `content-length`, …); letting a plugin rewrite them is how a
 * request is smuggled to a host other than the one that was validated.
 */
export const PLUGIN_HTTP_FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'proxy-authorization',
  'te',
  'trailer',
  'keep-alive',
]);

/**
 * How much of a `PluginError` message reaches the caller. The message is the
 * plugin's to write, and a plugin is not a trusted author of our responses.
 */
export const PLUGIN_ERROR_MESSAGE_MAX = 300;

/**
 * Sealed-box purpose for the secret fields of an installation's config. The slug
 * is appended, so a box sealed for one plugin does not open for another.
 */
export const PLUGIN_SECRET_PURPOSE_PREFIX = 'plugin-config:';

/**
 * Minimum length of `PLUGINS_SECRET`, the key installation secrets are sealed
 * under. Same floor as the gateway secret, for the same reason.
 */
export const PLUGINS_SECRET_MIN_LENGTH = 32;

/**
 * Budget for the action routes, per consumer across every plugin. An action may
 * call a third party with a tenant's credentials, and that party's quota is
 * spent whether or not the answer is useful to anyone.
 */
export const PLUGIN_ACTION_RATE_LIMIT: RateLimitPolicy = {
  name: 'plugins:action',
  limit: 120,
  windowMs: 60 * 1000,
  per: 'consumer',
};

// ── The plugins folder ────────────────────────────────────────────────────────

/**
 * THE plugins folder: `<working directory>/plugins/<slug>/`, at the repository
 * root. Every plugin lives here — the ones Cosmos Pay support ships with the
 * repository and the ones an operator installs by hand — and none runs until
 * its slug is listed in `PLUGINS_ENABLED`.
 */
export const PLUGINS_FOLDER = 'plugins';

/** What the plugin is and may touch — the file a reviewer reads first. */
export const PLUGIN_MANIFEST_FILE = 'plugin.json';

/** The plugin's code: plain TypeScript, transpiled at boot. */
export const PLUGIN_SOURCE_FILE = 'index.ts';

/** The signature over the two files above (`npm run plugins -- sign`). */
export const PLUGIN_SIGNATURE_FILE = 'signature.json';

/**
 * Names the signed payload's layout. Part of what is signed, so a signature
 * made for one layout never verifies as another.
 */
export const PLUGIN_SIGNATURE_FORMAT = 'cosmos-plugin-signature/v2';

/** One plugin's source; anything this size is not one file of plugin code. */
export const PLUGIN_SOURCE_MAX_BYTES = 512 * 1024;

/** A manifest is a page of JSON. */
export const PLUGIN_MANIFEST_MAX_BYTES = 64 * 1024;

/**
 * Budget for a plugin's top level — the module body, before any handler runs.
 * Bounds the boot-time load and every invocation's load alike.
 */
export const PLUGIN_EVAL_TIMEOUT_MS = 1_000;

/**
 * What plugin code may `import`: the SDK, under the alias this repo uses or
 * under the package name an external author would use. Everything else —
 * `node:*`, npm packages, relative files — throws at load.
 */
export const PLUGIN_SDK_IMPORTS: ReadonlySet<string> = new Set([
  '@/plugins/sdk',
  '@cosmos-pay/plugin-sdk',
]);

/** Name a trusted signing key is referred to by, in signatures and config. */
export const PLUGIN_KEY_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Cosmos Pay support's plugin signing keys — `<keyId>:<base64url Ed25519
 * public key>`, as `npm run plugins -- keygen` prints them.
 *
 * Every deployment trusts these with no configuration. That is what makes a
 * plugin "preinstalled by support": it sits in `plugins/` in this repository,
 * signed with one of these keys, so it loads anywhere as soon as it is enabled.
 * Anything else in the folder needs a signer the operator listed in
 * PLUGINS_TRUSTED_KEYS.
 *
 * The private half never enters a repository. Rotating it is: keygen, replace
 * the entry here, re-sign every plugin support ships — in one reviewed PR.
 */
export const PLUGIN_SUPPORT_KEYS: readonly string[] = [
  'cosmos-support:WbPYsfv0GAnXAtPELNbzDZWjKbCjKZWnn8aZ6LF7_oo',
];

/** Longest `name`, `description` or `author` a manifest may carry. */
export const PLUGIN_MANIFEST_TEXT_MAX = 500;

/** Longest string value a tenant may give a plugin setting. */
export const PLUGIN_CONFIG_VALUE_MAX = 2000;

/** HTTP methods `ctx.http` sends. */
export const PLUGIN_HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

/**
 * What a core id looks like (a cuid). A plugin-supplied id that is anything
 * else is refused before it reaches a query.
 */
export const PLUGIN_CORE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `npm run plugins -- install`: budget for each registry request. */
export const PLUGIN_REGISTRY_TIMEOUT_MS = 30_000;

/** `npm run plugins -- install`: the registry's `index.json`. */
export const PLUGIN_REGISTRY_INDEX_MAX_BYTES = 1024 * 1024;

/** A `signature.json` is a few hundred bytes; anything this size is not one. */
export const PLUGIN_SIGNATURE_MAX_BYTES = 64 * 1024;

/**
 * Heap cap for the isolate one invocation runs in. A plugin that needs more is
 * doing more than a plugin should; it fails alone, and the service's own heap
 * is never touched.
 */
export const PLUGIN_ISOLATE_MEMORY_MB = 32;
