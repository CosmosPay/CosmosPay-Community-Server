/**
 * The plugin SDK — the ONLY module a plugin's `index.ts` may import
 * (`eslint.config.mjs` refuses anything else under `plugins/`, `node:*`
 * included, and the loader refuses it again at boot).
 *
 * A plugin is a folder, `plugins/<slug>/`:
 *
 *   plugin.json   — {@link PluginManifest}: what it is and what it may touch
 *   index.ts      — `export default defineHandlers({ queries, commands, events })`
 *   signature.json — who vouches for the two files above
 *
 * A plugin never receives Prisma, a Nest provider, `process.env` or a socket.
 * It receives a {@link PluginContext}: a frozen object of closures, built per
 * invocation, that reaches exactly what the plugin declared in its manifest and
 * the tenant granted at install time:
 *
 *   - `ctx.storage` — the plugin's OWN records, scoped to one installation (one
 *     tenant). It cannot name another plugin's rows, or another tenant's.
 *   - `ctx.core`    — the core's customers, products and payment intents, through
 *     the core's own services: tenant-filtered, validated with the core's own
 *     DTOs, returned as public projections. No deletes, no raw rows.
 *   - `ctx.http`    — HTTPS to the hosts listed in `egress`, and nowhere else;
 *     never a private address.
 *
 * Everything this file exports is types, `defineHandlers`, `PluginError` and a
 * few input readers. It imports nothing, so reading it tells you the whole surface.
 */

// ── JSON ──────────────────────────────────────────────────────────────────────

export type PluginJson =
  | string
  | number
  | boolean
  | null
  | PluginJson[]
  | { [key: string]: PluginJson };

export type PluginJsonObject = { [key: string]: PluginJson };

// ── Capabilities ──────────────────────────────────────────────────────────────

/**
 * What a plugin may do with the core, declared in the manifest and consented to
 * by the tenant when installing. Storage in the plugin's own records needs no
 * capability; outbound HTTP is governed by `egress` instead.
 *
 * There is deliberately no delete capability, and nothing that moves money.
 */
export const PLUGIN_CAPABILITIES = [
  'customers:read',
  'customers:write',
  'products:read',
  'products:write',
  'payment_intents:read',
] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

/**
 * Core events a plugin may subscribe to. Each needs `payment_intents:read`:
 * an event is a read of the row it describes.
 */
export const PLUGIN_EVENT_TYPES = [
  'PAYMENT_INTENT_CREATED',
  'PAYMENT_INTENT_UPDATED',
  'PAYMENT_INTENT_SUCCEEDED',
  'PAYMENT_INTENT_FAILED',
  'PAYMENT_INTENT_CANCELLED',
  'PAYMENT_INTENT_DELETED',
] as const;

export type PluginEventType = (typeof PLUGIN_EVENT_TYPES)[number];

// ── Core projections (what a plugin sees of a core row) ───────────────────────

/** Dates arrive as ISO-8601 strings: every value crosses a JSON boundary. */
export interface PluginCustomer {
  id: string;
  name: string;
  alias: string | null;
  email: string | null;
  account: string | null;
  note: string | null;
  reference: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PluginCustomerInput {
  name?: string;
  alias?: string;
  email?: string;
  account?: string;
  note?: string;
  reference?: string;
}

export interface PluginProduct {
  id: string;
  name: string;
  description: string | null;
  amount: string | null;
  asset: string;
  kind: string;
  active: boolean;
  reference: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PluginProductInput {
  name?: string;
  description?: string;
  amount?: string;
  assetCode?: string;
  kind?: 'recurring' | 'one_time' | 'link';
  active?: boolean;
  reference?: string;
}

export interface PluginPaymentIntent {
  id: string;
  kind: string;
  status: string;
  source: string | null;
  destination: string;
  amount: string | null;
  asset: string;
  assetIssuer: string | null;
  memo: string;
  network: string;
  txHash: string | null;
  reference: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PluginPage<T> {
  data: T[];
  total: number;
  take: number;
  skip: number;
}

export interface PluginPageQuery {
  take?: number;
  skip?: number;
}

// ── The context ───────────────────────────────────────────────────────────────

export interface PluginStoredRecord {
  key: string;
  value: PluginJson;
  updatedAt: string;
}

export interface PluginStorage {
  get(collection: string, key: string): Promise<PluginJson | null>;
  /** Insert or replace. Fails with a quota error past the installation's cap. */
  put(collection: string, key: string, value: PluginJson): Promise<void>;
  /** True when a record was removed. */
  delete(collection: string, key: string): Promise<boolean>;
  /** Keys in ascending order; pass `nextCursor` back as `after` for the next page. */
  list(
    collection: string,
    options?: { prefix?: string; take?: number; after?: string },
  ): Promise<{ items: PluginStoredRecord[]; nextCursor: string | null }>;
}

export interface PluginCoreApi {
  /** Needs `customers:read` (reads) / `customers:write` (create, update). */
  customers: {
    list(query?: PluginPageQuery): Promise<PluginPage<PluginCustomer>>;
    get(id: string): Promise<PluginCustomer | null>;
    create(
      input: PluginCustomerInput & { name: string },
    ): Promise<PluginCustomer>;
    update(id: string, input: PluginCustomerInput): Promise<PluginCustomer>;
  };
  /** Needs `products:read` / `products:write`. */
  products: {
    list(query?: PluginPageQuery): Promise<PluginPage<PluginProduct>>;
    get(id: string): Promise<PluginProduct | null>;
    create(
      input: PluginProductInput & { name: string },
    ): Promise<PluginProduct>;
    update(id: string, input: PluginProductInput): Promise<PluginProduct>;
  };
  /** Needs `payment_intents:read`. Read-only: a plugin never moves money. */
  paymentIntents: {
    list(
      query?: PluginPageQuery & { status?: string },
    ): Promise<PluginPage<PluginPaymentIntent>>;
    get(id: string): Promise<PluginPaymentIntent | null>;
  };
}

export interface PluginHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** `https://` on a host listed in the manifest's `egress`. */
  url: string;
  headers?: Record<string, string>;
  /** A string is sent as is; anything else is sent as JSON. */
  body?: string | PluginJson;
}

export interface PluginHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** `JSON.parse(body)`, or throws `PluginError` when the body is not JSON. */
  json(): PluginJson;
}

export interface PluginHttp {
  request(request: PluginHttpRequest): Promise<PluginHttpResponse>;
}

export interface PluginLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type PluginConfigValue = string | number | boolean;

export interface PluginContext {
  readonly plugin: { readonly slug: string; readonly version: string };
  readonly installation: {
    readonly id: string;
    /** The tenant's config, secrets included (decrypted for this call only). */
    readonly config: Readonly<Record<string, PluginConfigValue>>;
  };
  readonly storage: PluginStorage;
  readonly core: PluginCoreApi;
  readonly http: PluginHttp;
  readonly log: PluginLogger;
}

// ── The manifest ──────────────────────────────────────────────────────────────

export interface PluginConfigField {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
  /**
   * Sealed at rest under `PLUGINS_SECRET` and never returned by any route —
   * a tenant's API key for the plugin's own service goes here.
   */
  secret?: boolean;
}

export type PluginActionHandler = (
  ctx: PluginContext,
  input: PluginJsonObject,
) => Promise<PluginJson> | PluginJson;

export interface PluginEvent {
  type: PluginEventType;
  /** The payment intent the event is about, as `ctx.core.paymentIntents.get` returns it. */
  data: PluginPaymentIntent;
}

export type PluginEventHandler = (
  ctx: PluginContext,
  event: PluginEvent,
) => Promise<void> | void;

/** `plugin.json`: what the plugin is and what it may touch. */
export interface PluginManifest {
  /** URL-safe, unique, permanent: `/v1/plugins/{slug}/...`. Same as the folder name. */
  slug: string;
  name: string;
  /** Semver. Recorded on the installation the tenant consents to. */
  version: string;
  description: string;
  /** Who maintains it — a person, a company, a repository URL. */
  author: string;
  capabilities: readonly PluginCapability[];
  /** Hostnames `ctx.http` may reach. Exact names, no wildcards, no IPs. */
  egress?: readonly string[];
  config?: Readonly<Record<string, PluginConfigField>>;
}

/** `index.ts`: what the plugin does. */
export interface PluginHandlers {
  /** Side-effect-free actions: `POST /v1/plugins/{slug}/queries/{action}`, `plugins:read`. */
  queries?: Readonly<Record<string, PluginActionHandler>>;
  /** Actions that write: `POST /v1/plugins/{slug}/commands/{action}`, `plugins:write`. */
  commands?: Readonly<Record<string, PluginActionHandler>>;
  events?: Readonly<Partial<Record<PluginEventType, PluginEventHandler>>>;
}

/** A loaded plugin: its manifest and its handlers, together. */
export interface PluginDefinition extends PluginManifest, PluginHandlers {}

/**
 * What a plugin's `index.ts` exports as default. The identity function, typed —
 * it exists so the handlers are checked where they are written. The runtime
 * validates them again, against `plugin.json`, at boot.
 *
 *   export default defineHandlers({
 *     queries: { 'get-notes': async (ctx, input) => { ... } },
 *   });
 */
export function defineHandlers<const T extends PluginHandlers>(handlers: T): T {
  return handlers;
}

/** A whole plugin in one object — for tests, which build fakes inline. */
export function definePlugin<const T extends PluginDefinition>(
  definition: T,
): T {
  return definition;
}

// ── Errors and input readers ──────────────────────────────────────────────────

/**
 * Throw it to refuse a request: the caller gets `400 plugin_rejected` with this
 * message. Anything else a plugin throws is a bug — the caller gets `502
 * plugin_failed` and the detail goes to the log only.
 */
export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginError';
  }
}

export function requireString(
  input: PluginJsonObject,
  field: string,
  options: { max?: number } = {},
): string {
  const value = input[field];
  const max = options.max ?? 500;
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new PluginError(
      `${field} must be a non-empty string of at most ${max} characters`,
    );
  }
  return value.trim();
}

export function optionalString(
  input: PluginJsonObject,
  field: string,
  options: { max?: number } = {},
): string | undefined {
  return input[field] === undefined || input[field] === null
    ? undefined
    : requireString(input, field, options);
}

export function requireStringArray(
  input: PluginJsonObject,
  field: string,
  options: { maxItems?: number; maxLength?: number } = {},
): string[] {
  const value = input[field];
  const maxItems = options.maxItems ?? 50;
  const maxLength = options.maxLength ?? 100;
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some(
      (item) =>
        typeof item !== 'string' ||
        item.trim() === '' ||
        item.length > maxLength,
    )
  ) {
    throw new PluginError(
      `${field} must be an array of at most ${maxItems} non-empty strings of at most ${maxLength} characters`,
    );
  }
  return (value as string[]).map((item) => item.trim());
}
