import ivm from 'isolated-vm';
import { ApiError } from '@/common/errors/api-error';
import { ConcurrencyLimiter } from '@/plugins/concurrency-limiter';
import {
  PluginQuotaError,
  PluginTimeoutError,
  PluginViolationError,
} from '@/plugins/plugin-errors';
import {
  PLUGIN_EVAL_TIMEOUT_MS,
  PLUGIN_INVOCATION_TIMEOUT_MS,
  PLUGIN_ISOLATE_MEMORY_MB,
  PLUGIN_MAX_CONCURRENT_CALLS_PER_INVOCATION,
  PLUGIN_SDK_IMPORTS,
} from '@/plugins/plugins.constants';
import {
  definePlugin,
  defineHandlers,
  optionalString,
  PLUGIN_CAPABILITIES,
  PLUGIN_EVENT_TYPES,
  PluginError,
  requireString,
  requireStringArray,
  type PluginActionHandler,
  type PluginContext,
  type PluginEventHandler,
  type PluginCustomerInput,
  type PluginHandlers,
  type PluginHttpRequest,
  type PluginJson,
  type PluginPageQuery,
  type PluginProductInput,
} from '@/plugins/sdk';

/**
 * Where plugin code runs: a separate V8 isolate per invocation.
 *
 * An isolate is a heap of its own with none of Node inside it — no `process`,
 * no `require`, no network, no file system, no timers — running on a thread of
 * its own under a memory cap. Nothing from this process is ever handed to it:
 * the only way out is one bridge function that takes a method NAME from a
 * fixed list and JSON arguments, and answers with JSON. So:
 *
 *   - code written to escape finds nothing to escape to — there is no object
 *     of this process in the isolate to climb from;
 *   - a runaway loop is stopped: the isolate is disposed when the budget ends,
 *     which terminates it wherever it is, and it never held this event loop —
 *     an invocation compiles, loads and runs the plugin on the isolate's
 *     thread, top level included, never with a synchronous call from here;
 *   - memory is bounded per invocation, and a plugin that exceeds it fails
 *     alone;
 *   - nothing survives an invocation: module-level state cannot carry one
 *     tenant's data into another tenant's call.
 */

export interface SandboxLimits {
  timeoutMs: number;
  memoryMb: number;
}

const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: PLUGIN_INVOCATION_TIMEOUT_MS,
  memoryMb: PLUGIN_ISOLATE_MEMORY_MB,
};

type Kind = 'query' | 'command' | 'event';

/** What the plugin's default export declares, read at load. */
export interface PluginShape {
  queries: string[];
  commands: string[];
  events: string[];
}

/**
 * The SDK, as code for the isolate. Built from the very functions `sdk.ts`
 * exports — one implementation, so a message or a rule cannot drift between
 * what a spec exercises and what a plugin gets.
 */
const SANDBOX_SDK = `
${PluginError.toString()}
const PLUGIN_CAPABILITIES = ${JSON.stringify(PLUGIN_CAPABILITIES)};
const PLUGIN_EVENT_TYPES = ${JSON.stringify(PLUGIN_EVENT_TYPES)};
const definePlugin = ${definePlugin.toString()};
const defineHandlers = ${defineHandlers.toString()};
const requireString = ${requireString.toString()};
const optionalString = ${optionalString.toString()};
const requireStringArray = ${requireStringArray.toString()};
`;

/**
 * Runs first in every isolate, before any plugin code: captures the bridge in
 * a closure and removes it from the global object, then installs the only two
 * entry points the host calls — load and dispatch. Plugin code that later
 * rewrites globals changes nothing the host relies on: the host holds
 * references to these functions, taken before the plugin ran.
 *
 * The options the bridge is called with are built here too, frozen and with no
 * prototype. isolated-vm reads an option with an ordinary property lookup,
 * which climbs the prototype chain, so a plugin that set
 * `Object.prototype.reference = true` would otherwise be choosing how the
 * host's answer crosses over — and a reference to a host object is the one
 * thing that must never reach the isolate.
 */
const BOOTSTRAP = `
(function () {
  'use strict';
  const bridge = globalThis.__cosmosBridge;
  delete globalThis.__cosmosBridge;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const freeze = Object.freeze;
  const BRIDGE_OPTIONS = freeze({
    __proto__: null,
    arguments: freeze({ __proto__: null, copy: true }),
    result: freeze({ __proto__: null, promise: true, copy: true }),
  });
  ${SANDBOX_SDK}
  class PluginHostFailure extends Error {
    constructor(kind, message) {
      super(message);
      this.name = 'PluginHostFailure';
      this.kind = kind;
    }
  }
  const SDK = freeze({
    PluginError, PLUGIN_CAPABILITIES, PLUGIN_EVENT_TYPES,
    definePlugin, defineHandlers, requireString, optionalString, requireStringArray,
  });
  const SDK_IMPORTS = ${JSON.stringify([...PLUGIN_SDK_IMPORTS])};

  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      freeze(value);
      for (const inner of Object.values(value)) deepFreeze(inner);
    }
    return value;
  }

  async function call(method, args) {
    const raw = await bridge.apply(undefined, [method, stringify(args)], BRIDGE_OPTIONS);
    const reply = parse(raw);
    if (reply.ok) return reply.value;
    if (reply.kind === 'rejected') throw new PluginError(reply.message);
    throw new PluginHostFailure(reply.kind, reply.message);
  }

  function context(meta) {
    const fn = (method) => (...args) => call(method, args);
    const log = (level) => (message) => {
      call('log.' + level, [String(message)]).catch(() => undefined);
    };
    return deepFreeze({
      plugin: meta.plugin,
      installation: meta.installation,
      storage: {
        get: fn('storage.get'), put: fn('storage.put'),
        compareAndSet: fn('storage.compareAndSet'),
        delete: fn('storage.delete'), list: fn('storage.list'),
      },
      core: {
        customers: {
          list: fn('core.customers.list'), get: fn('core.customers.get'),
          create: fn('core.customers.create'), update: fn('core.customers.update'),
        },
        products: {
          list: fn('core.products.list'), get: fn('core.products.get'),
          create: fn('core.products.create'), update: fn('core.products.update'),
        },
        paymentIntents: {
          list: fn('core.paymentIntents.list'), get: fn('core.paymentIntents.get'),
        },
      },
      http: {
        request: async (request) => {
          const r = await call('http.request', [request]);
          return freeze({
            status: r.status,
            headers: freeze(r.headers),
            body: r.body,
            json() {
              try { return parse(r.body); }
              catch { throw new PluginError('The response body is not JSON'); }
            },
          });
        },
      },
      log: { log: log('log'), warn: log('warn'), error: log('error') },
    });
  }

  let handlers = null;

  globalThis.__cosmosLoad = function (moduleFactory) {
    const module = { exports: {} };
    const require = (id) => {
      if (SDK_IMPORTS.includes(id)) return SDK;
      throw new Error('a plugin may only import ' + SDK_IMPORTS.join(' or ') + ', not "' + id + '"');
    };
    moduleFactory(module, module.exports, require);
    const exported = module.exports && module.exports.default;
    if (!exported || typeof exported !== 'object') {
      throw new Error('index.ts must \`export default defineHandlers({ ... })\`');
    }
    const shape = { queries: [], commands: [], events: [] };
    for (const key of Object.keys(exported)) {
      if (!(key in shape)) {
        throw new Error('index.ts exports unknown field(s): ' + key +
          '. Name, version, capabilities and the rest belong in plugin.json');
      }
      const group = exported[key];
      if (!group || typeof group !== 'object') throw new Error(key + ' must be an object');
      for (const name of Object.keys(group)) {
        if (typeof group[name] !== 'function') {
          throw new Error(key + '.' + name + ' must be a function');
        }
        shape[key].push(name);
      }
    }
    handlers = exported;
    return stringify(shape);
  };

  globalThis.__cosmosDispatch = async function (kind, name, payloadJson, metaJson) {
    try {
      const group = kind === 'query' ? handlers.queries
        : kind === 'command' ? handlers.commands : handlers.events;
      const handler = group && Object.prototype.hasOwnProperty.call(group, name)
        ? group[name] : undefined;
      if (typeof handler !== 'function') {
        return stringify({ ok: false, kind: 'crash', message: 'no ' + kind + ' ' + name });
      }
      const output = await handler(context(parse(metaJson)), deepFreeze(parse(payloadJson)));
      return stringify({ ok: true, value: output === undefined ? null : output });
    } catch (err) {
      if (err instanceof PluginError) {
        return stringify({ ok: false, kind: 'rejected', message: String(err.message) });
      }
      if (err instanceof PluginHostFailure) {
        return stringify({ ok: false, kind: err.kind, message: String(err.message) });
      }
      return stringify({ ok: false, kind: 'crash', message: String(err && err.message || err) });
    }
  };
})();
`;

/**
 * The host side of the bridge: which method names exist, and what each does
 * with the invocation's context. Nothing outside this table is callable.
 */
type HostArgs = readonly unknown[];

/**
 * Casts for the bridge's arguments. They are whatever the plugin sent, so the
 * type is a claim, not a check: each method below hands them to a context
 * method that validates them itself (storage keys and sizes, core DTOs and
 * ids, egress URLs) before anything happens.
 */
const str = (v: unknown) => v as string;
const obj = <T>(v: unknown) => (v ?? undefined) as T;

const HOST_METHODS: Readonly<
  Record<string, (ctx: PluginContext, a: HostArgs) => unknown>
> = {
  'storage.get': (ctx, a) => ctx.storage.get(str(a[0]), str(a[1])),
  'storage.put': (ctx, a) =>
    ctx.storage.put(str(a[0]), str(a[1]), a[2] as PluginJson),
  'storage.compareAndSet': (ctx, a) =>
    ctx.storage.compareAndSet(
      str(a[0]),
      str(a[1]),
      (a[2] ?? null) as PluginJson | null,
      a[3] as PluginJson,
    ),
  'storage.delete': (ctx, a) => ctx.storage.delete(str(a[0]), str(a[1])),
  'storage.list': (ctx, a) =>
    ctx.storage.list(
      str(a[0]),
      obj<Parameters<PluginContext['storage']['list']>[1]>(a[1]),
    ),
  'core.customers.list': (ctx, a) =>
    ctx.core.customers.list(obj<PluginPageQuery>(a[0])),
  'core.customers.get': (ctx, a) => ctx.core.customers.get(str(a[0])),
  'core.customers.create': (ctx, a) =>
    ctx.core.customers.create(
      obj<PluginCustomerInput & { name: string }>(a[0]),
    ),
  'core.customers.update': (ctx, a) =>
    ctx.core.customers.update(str(a[0]), obj<PluginCustomerInput>(a[1])),
  'core.products.list': (ctx, a) =>
    ctx.core.products.list(obj<PluginPageQuery>(a[0])),
  'core.products.get': (ctx, a) => ctx.core.products.get(str(a[0])),
  'core.products.create': (ctx, a) =>
    ctx.core.products.create(obj<PluginProductInput & { name: string }>(a[0])),
  'core.products.update': (ctx, a) =>
    ctx.core.products.update(str(a[0]), obj<PluginProductInput>(a[1])),
  'core.paymentIntents.list': (ctx, a) =>
    ctx.core.paymentIntents.list(
      obj<PluginPageQuery & { status?: string }>(a[0]),
    ),
  'core.paymentIntents.get': (ctx, a) => ctx.core.paymentIntents.get(str(a[0])),
  'http.request': async (ctx, a) => {
    const response = await ctx.http.request(obj<PluginHttpRequest>(a[0]));
    return {
      status: response.status,
      headers: response.headers,
      body: response.body,
    };
  },
  'log.log': (ctx, a) => ctx.log.log(String(a[0])),
  'log.warn': (ctx, a) => ctx.log.warn(String(a[0])),
  'log.error': (ctx, a) => ctx.log.error(String(a[0])),
};

/** One invocation, as the bridge sees it. */
interface BridgeScope {
  ctx: PluginContext;
  /** Context calls this invocation may have in flight; the rest queue. */
  calls: ConcurrencyLimiter;
  /**
   * The first failure that is not the plugin's to handle — a violation, or the
   * core failing — sticks: the invocation fails even if the plugin catches it,
   * so a plugin cannot probe what it was not granted in silence.
   */
  fatal: Error | null;
  /** Set when the invocation ends; a call still queued then never runs. */
  over: boolean;
}

/** A plugin's compiled code, run in a fresh isolate for every call. */
export class PluginSandbox {
  constructor(
    private readonly code: string,
    private readonly fileName: string,
    private readonly limits: SandboxLimits = DEFAULT_LIMITS,
  ) {}

  /**
   * Loads the plugin once, to read what it exports. Runs at boot (and in
   * `npm run plugins -- check`), so it is synchronous: the top level runs
   * under the eval budget, in an isolate disposed after, with no context to
   * reach.
   */
  describe(): PluginShape {
    const isolate = new ivm.Isolate({ memoryLimit: this.limits.memoryMb });
    try {
      const context = isolate.createContextSync();
      const global = context.global;
      global.setSync(
        '__cosmosBridge',
        new ivm.Reference((method: string, argsJson: string) =>
          this.bridge(null, method, argsJson),
        ),
      );
      isolate.compileScriptSync(BOOTSTRAP).runSync(context);
      const loader = global.getSync('__cosmosLoad', { reference: true });
      isolate
        .compileScriptSync(this.wrapped(), { filename: this.fileName })
        .runSync(context, { timeout: PLUGIN_EVAL_TIMEOUT_MS });
      const factory = global.getSync('__cosmosModule', { reference: true });
      const shape = loader.applySync(undefined, [factory.derefInto()], {
        timeout: PLUGIN_EVAL_TIMEOUT_MS,
        result: { copy: true },
      }) as string;
      return JSON.parse(shape) as PluginShape;
    } finally {
      isolate.dispose();
    }
  }

  /** Handlers the runtime calls: each one runs the plugin in a new isolate. */
  handlers(shape: PluginShape): PluginHandlers {
    const group = <H>(names: string[], make: (name: string) => H) =>
      Object.fromEntries(names.map((name) => [name, make(name)])) as Record<
        string,
        H
      >;
    return {
      queries: group<PluginActionHandler>(
        shape.queries,
        (name) => (ctx, input) => this.invoke('query', name, ctx, input),
      ),
      commands: group<PluginActionHandler>(
        shape.commands,
        (name) => (ctx, input) => this.invoke('command', name, ctx, input),
      ),
      events: group<PluginEventHandler>(
        shape.events,
        (name) => async (ctx, event) => {
          await this.invoke('event', name, ctx, event);
        },
      ),
    };
  }

  /**
   * The plugin's CommonJS, wrapped in a function the loader calls with its own
   * `require`. Defining it runs nothing yet.
   */
  private wrapped(): string {
    return `globalThis.__cosmosModule = function (module, exports, require) {\n${this.code}\n};`;
  }

  /**
   * A fresh context with the bootstrap and the plugin's module loaded in it,
   * and the bootstrap's dispatch entry point. Every step is asynchronous: the
   * compile, the module's top level and the load run on the isolate's thread,
   * so a plugin that spends its whole eval budget at the top level spends none
   * of this event loop.
   */
  private async load(
    isolate: ivm.Isolate,
    scope: BridgeScope,
  ): Promise<ivm.Reference> {
    const context = await isolate.createContext();
    const global = context.global;
    await global.set(
      '__cosmosBridge',
      new ivm.Reference((method: string, argsJson: string) =>
        this.bridge(scope, method, argsJson),
      ),
    );
    await (await isolate.compileScript(BOOTSTRAP)).run(context);
    // Taken now, before any plugin code runs: whatever the plugin later does to
    // its globals, these references still point at the bootstrap's functions.
    const loader = await global.get('__cosmosLoad', { reference: true });
    const dispatch = await global.get('__cosmosDispatch', { reference: true });
    await (
      await isolate.compileScript(this.wrapped(), { filename: this.fileName })
    ).run(context, { timeout: PLUGIN_EVAL_TIMEOUT_MS });
    const factory = await global.get('__cosmosModule', { reference: true });
    await loader.apply(undefined, [factory.derefInto()], {
      timeout: PLUGIN_EVAL_TIMEOUT_MS,
      result: { copy: true },
    });
    return dispatch;
  }

  private async invoke(
    kind: Kind,
    name: string,
    ctx: PluginContext,
    payload: unknown,
  ): Promise<any> {
    const isolate = new ivm.Isolate({ memoryLimit: this.limits.memoryMb });
    const scope: BridgeScope = {
      ctx,
      calls: new ConcurrencyLimiter(PLUGIN_MAX_CONCURRENT_CALLS_PER_INVOCATION),
      fatal: null,
      over: false,
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      const meta = JSON.stringify({
        plugin: ctx.plugin,
        installation: ctx.installation,
      });
      const run = (async () => {
        const dispatch = await this.load(isolate, scope);
        return (await dispatch.apply(
          undefined,
          [kind, name, JSON.stringify(payload ?? null), meta],
          { arguments: { copy: true }, result: { promise: true, copy: true } },
        )) as string;
      })();
      // Once the deadline wins, the isolate is disposed and `run` rejects with
      // nobody listening; that rejection is expected, not unhandled.
      run.catch(() => undefined);
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new PluginTimeoutError(
                `Plugin ${ctx.plugin.slug} did not finish ${kind} ${name} within ${this.limits.timeoutMs} ms`,
              ),
            ),
          this.limits.timeoutMs,
        );
        timer.unref();
      });
      const reply = JSON.parse(await Promise.race([run, deadline])) as {
        ok: boolean;
        value?: unknown;
        kind?: string;
        message?: string;
      };

      if (scope.fatal) throw scope.fatal;
      if (reply.ok) return reply.value;
      const message = String(reply.message ?? '');
      switch (reply.kind) {
        case 'rejected':
          throw new PluginError(message);
        case 'quota':
          throw new PluginQuotaError(message);
        case 'violation':
          throw new PluginViolationError(message);
        default:
          throw new Error(`Plugin ${ctx.plugin.slug} threw: ${message}`);
      }
    } catch (err) {
      if (scope.fatal) throw scope.fatal;
      if (
        err instanceof PluginError ||
        err instanceof PluginQuotaError ||
        err instanceof PluginViolationError ||
        err instanceof PluginTimeoutError ||
        (err instanceof Error && err.message.startsWith('Plugin '))
      ) {
        throw err;
      }
      // An isolate that ran out of memory, a top level over its eval budget,
      // or any other engine failure.
      throw new Error(
        `Plugin ${ctx.plugin.slug} failed in its sandbox: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    } finally {
      scope.over = true;
      clearTimeout(timer);
      // Disposing terminates whatever is still running — a loop, a pending
      // await — and frees the heap. Nothing of this call outlives it.
      if (!isolate.isDisposed) isolate.dispose();
    }
  }

  /** One call across the bridge. Always answers JSON; never throws into the isolate. */
  private async bridge(
    scope: BridgeScope | null,
    method: string,
    argsJson: string,
  ): Promise<string> {
    const reply = (value: unknown) => JSON.stringify(value);
    const handler = Object.hasOwn(HOST_METHODS, method)
      ? HOST_METHODS[method]
      : undefined;
    if (!scope || !handler) {
      const err = new PluginViolationError(
        `Plugin called "${String(method).slice(0, 60)}", which is not a context method`,
      );
      if (scope) scope.fatal ??= err;
      return reply({ ok: false, kind: 'violation', message: err.message });
    }
    try {
      const args: unknown = JSON.parse(argsJson);
      const value = await scope.calls.run(() => {
        if (scope.over) {
          return Promise.reject(
            new PluginViolationError(
              `Plugin ${scope.ctx.plugin.slug} used its context after the invocation ended`,
            ),
          );
        }
        return Promise.resolve(
          handler(scope.ctx, Array.isArray(args) ? args : []),
        );
      });
      return reply({ ok: true, value: value === undefined ? null : value });
    } catch (err) {
      if (err instanceof PluginError) {
        return reply({ ok: false, kind: 'rejected', message: err.message });
      }
      if (err instanceof PluginQuotaError) {
        return reply({ ok: false, kind: 'quota', message: err.message });
      }
      // A core service refusing the plugin's input is the plugin's to handle.
      if (err instanceof ApiError && err.getStatus() < 500) {
        return reply({ ok: false, kind: 'rejected', message: err.message });
      }
      const fatal = err instanceof Error ? err : new Error(String(err));
      scope.fatal ??= fatal;
      return reply({
        ok: false,
        kind: err instanceof PluginViolationError ? 'violation' : 'failed',
        message:
          err instanceof PluginViolationError
            ? err.message
            : 'The service could not complete this call',
      });
    }
  }
}
