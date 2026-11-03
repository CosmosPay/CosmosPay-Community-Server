import type { RateLimitPolicy } from '@/common/decorators/rate-limit.decorator';
import { POOL_MAX } from '@/prisma/prisma.constants';

/**
 * Limits the plugin runtime puts around every piece of plugin code.
 *
 * The isolate (`plugin-sandbox.ts`) keeps plugin code out of this process; these
 * bound how much of the core a plugin can spend through the bridge it is given —
 * the database, the event loop, the memory, a tenant's quota — and they turn a
 * plugin that misbehaves into a failed request instead of a degraded service.
 */

/**
 * A plugin slug: the name its routes, its scopes in the logs and its rows are
 * filed under. Lowercase kebab-case, starting with a letter, so it is safe in a
 * URL path segment, a log prefix and a sealed-box purpose without escaping.
 */
export const PLUGIN_SLUG_RE = /^[a-z][a-z0-9-]{2,39}$/;

/**
 * Plugins compiled into this service rather than loaded from `plugins/`: first-
 * party integrations that are not the chain itself — a fiat provider, a DeFi
 * protocol — and that need what the sandbox deliberately withholds (their own
 * tables, inbound webhooks, deployment-wide credentials). They live under
 * `src/native-plugins/<slug>/`, the core never imports them, and they are
 * switched on by the same `PLUGINS_ENABLED` list as sandboxed plugins. A
 * sandboxed plugin may not take one of these slugs.
 */
export const NATIVE_PLUGIN_SLUGS = [
  'blindpay',
  'defindex',
  'trustless-work',
] as const;
export type NativePluginSlug = (typeof NATIVE_PLUGIN_SLUGS)[number];

export function isNativePluginSlug(slug: string): slug is NativePluginSlug {
  return (NATIVE_PLUGIN_SLUGS as readonly string[]).includes(slug);
}

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

/**
 * Context calls one invocation may have in flight at once; the rest wait their
 * turn. Without it, `Promise.all` over 200 `storage.put`s holds 200 database
 * connections at once, which is every connection of the pool and then some: one
 * plugin call would stall every request of every tenant.
 */
export const PLUGIN_MAX_CONCURRENT_CALLS_PER_INVOCATION = 4;

/**
 * Longest argument list one context call may send, as JSON characters. The
 * largest a legitimate call needs is an HTTP body ({@link PLUGIN_HTTP_MAX_REQUEST_BYTES})
 * with its headers. Checked before the JSON is parsed, so an oversized call
 * costs this process nothing but the refusal.
 */
export const PLUGIN_MAX_CALL_ARGS_CHARS = 512 * 1024;

/**
 * Argument JSON one invocation may have waiting for a call slot, in
 * characters. Calls the plugin does not await queue on this process's heap,
 * not the isolate's: without a bound, a plugin that keeps its slots busy and
 * fires calls in a loop grows the queue until the process runs out of memory.
 */
export const PLUGIN_MAX_PENDING_CALL_CHARS = 1024 * 1024;

/**
 * Storage and core calls running at once across every plugin invocation of the
 * process. Each one holds a database connection, and 16 invocations × 4 calls
 * would be more than the whole pool ({@link POOL_MAX}); plugins get a quarter
 * of it, and the rest of the service keeps the other three.
 */
export const PLUGIN_MAX_CONCURRENT_DB_CALLS = Math.max(
  1,
  Math.floor(POOL_MAX / 4),
);

/**
 * Plugin invocations (actions and events) this process runs at once. Each one is
 * a V8 isolate with up to {@link PLUGIN_ISOLATE_MEMORY_MB} of heap and a thread
 * of the isolate pool, and the per-minute budget does not bound how many overlap:
 * 120 slow calls a minute from each of many tenants are hundreds of isolates.
 * 16 × 32 MB is the most plugin heap this process can hold.
 */
export const PLUGIN_MAX_CONCURRENT_INVOCATIONS = 16;

/**
 * Actions one consumer may have running at once, so one tenant cannot take every
 * slot above. Past it the call is `429 rate_limited` with `Retry-After`.
 */
export const PLUGIN_MAX_CONCURRENT_INVOCATIONS_PER_CONSUMER = 4;

/** `Retry-After`, in seconds, on a call refused for having too many in flight. */
export const PLUGIN_BUSY_RETRY_AFTER_SECONDS = 1;

/**
 * Event deliveries one consumer may have running at once. Events wait for a
 * process slot instead of being refused, so without a share of their own a
 * tenant creating payment intents in a burst would fill every process slot with
 * its deliveries and turn every other tenant's actions into 429s.
 */
export const PLUGIN_MAX_CONCURRENT_EVENTS_PER_CONSUMER = 2;

/**
 * Event deliveries one consumer may have waiting or running. Past it the next
 * delivery is dropped and logged: an unbounded queue is memory the tenant
 * controls, and an event delivery is already best effort (a plugin that fails
 * on one is logged, never retried).
 */
export const PLUGIN_MAX_PENDING_EVENTS_PER_CONSUMER = 200;

/** Size of the JSON `input` an action accepts, serialized. */
export const PLUGIN_MAX_INPUT_BYTES = 64 * 1024;

/** Size of the JSON an action may return, serialized. */
export const PLUGIN_MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Longest answer an invocation may hand back across the bridge, in JSON
 * characters: the output cap plus room for the envelope. The isolate refuses a
 * bigger one itself, so a multi-megabyte answer is never copied into, or parsed
 * on, this process.
 */
export const PLUGIN_MAX_REPLY_CHARS = PLUGIN_MAX_OUTPUT_BYTES + 4096;

/** Longest plugin-written message the isolate hands back, in characters. */
export const PLUGIN_MAX_REPLY_MESSAGE_CHARS = 1000;

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
 * A header name a plugin may send: RFC 9110's `token`, bounded. Anything else
 * is the plugin's 400, not Node throwing from inside the request.
 */
export const PLUGIN_HTTP_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;

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

/**
 * The `NODE_ENV` values under which `PLUGINS_ALLOW_UNSIGNED=true` is accepted,
 * set explicitly. Everything else, unset included, refuses it.
 */
export const PLUGINS_UNSIGNED_NODE_ENVS: ReadonlySet<string> = new Set([
  'development',
  'test',
]);

/** A `signature.json` is a few hundred bytes; anything this size is not one. */
export const PLUGIN_SIGNATURE_MAX_BYTES = 64 * 1024;

/**
 * Characters a reviewed file may not contain. A signature is a statement about
 * what a reviewer read, and each of these makes what they read differ from
 * what runs:
 *   - bidirectional controls ("Trojan Source", CVE-2021-42574), which make an
 *     editor show code in an order the compiler does not run it in;
 *   - every default-ignorable code point (zero-width characters, the soft
 *     hyphen, Hangul fillers, variation selectors, the astral tag characters),
 *     which render as nothing and make two identical-looking names differ;
 *   - line terminators an editor may not draw as one: U+2028, U+2029 and a CR
 *     with no LF after it end a `//` comment for JavaScript, so code after one
 *     runs while it reads as part of the comment;
 *   - every other control character but tab, LF and CR.
 * A byte-order mark is allowed only as the first character of the file.
 */
export const PLUGIN_SOURCE_FORBIDDEN_CHARS_RE =
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\u2028\u2029\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]|\r(?!\n)/u;

/**
 * Heap cap for the isolate one invocation runs in. A plugin that needs more is
 * doing more than a plugin should; it fails alone, and the service's own heap
 * is never touched.
 */
export const PLUGIN_ISOLATE_MEMORY_MB = 32;
