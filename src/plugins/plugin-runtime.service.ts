import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import {
  PluginQuotaError,
  PluginTimeoutError,
  PluginViolationError,
} from '@/plugins/plugin-errors';
import {
  PluginCoreAccessService,
  projectPaymentIntent,
} from '@/plugins/plugin-core-access.service';
import { PluginHttpClient } from '@/plugins/plugin-http.client';
import {
  PluginInstallationsService,
  type ResolvedInstallation,
} from '@/plugins/plugin-installations.service';
import { PluginRegistryService } from '@/plugins/plugin-registry.service';
import { PluginStorageService } from '@/plugins/plugin-storage.service';
import {
  PLUGIN_ERROR_MESSAGE_MAX,
  PLUGIN_INVOCATION_TIMEOUT_MS,
  PLUGIN_MAX_CALLS_PER_INVOCATION,
  PLUGIN_MAX_INPUT_BYTES,
  PLUGIN_MAX_OUTPUT_BYTES,
} from '@/plugins/plugins.constants';
import {
  PLUGIN_EVENT_TYPES,
  PluginError,
  type PluginContext,
  type PluginDefinition,
  type PluginEventType,
  type PluginJson,
  type PluginJsonObject,
} from '@/plugins/sdk';

export type PluginActionKind = 'query' | 'command';

export interface PluginActionResult {
  plugin: string;
  action: string;
  output: PluginJson;
}

export function isPluginEventType(type: string): type is PluginEventType {
  return (PLUGIN_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * One invocation's lease on its context: a call budget, and a switch that
 * turns every context method off once the invocation is over.
 *
 * The switch matters because a timeout cannot stop JavaScript. A handler that
 * outlives its budget keeps running after the caller got its 504; revoking the
 * context is what stops that leftover work from writing storage, calling the
 * core or reaching the network on the tenant's behalf with nobody waiting.
 */
class InvocationLease {
  private calls = 0;
  private revoked = false;

  constructor(private readonly slug: string) {}

  spend(): void {
    if (this.revoked) {
      throw new PluginViolationError(
        `Plugin ${this.slug} used its context after the invocation ended`,
      );
    }
    this.calls += 1;
    if (this.calls > PLUGIN_MAX_CALLS_PER_INVOCATION) {
      throw new PluginViolationError(
        `Plugin ${this.slug} made more than ${PLUGIN_MAX_CALLS_PER_INVOCATION} context calls in one invocation`,
      );
    }
  }

  revoke(): void {
    this.revoked = true;
  }
}

/**
 * Runs plugin code, and is the only thing that does.
 *
 * Each run gets a fresh, frozen {@link PluginContext} built from closures over
 * THIS consumer and THIS installation — the plugin is never handed an id it
 * could swap for another tenant's — a call budget, a wall-clock limit, and a
 * single place where whatever the plugin throws becomes a response: its own
 * `PluginError` is a 400 with its message, anything else is a 502 whose detail
 * stays in the log.
 */
@Injectable()
export class PluginRuntimeService {
  private readonly logger = new Logger(PluginRuntimeService.name);

  constructor(
    private readonly registry: PluginRegistryService,
    private readonly installations: PluginInstallationsService,
    private readonly storage: PluginStorageService,
    private readonly core: PluginCoreAccessService,
    private readonly http: PluginHttpClient,
  ) {}

  async invoke(
    consumer: GatewayConsumer,
    slug: string,
    kind: PluginActionKind,
    action: string,
    input: Record<string, unknown> | undefined,
  ): Promise<PluginActionResult> {
    const plugin = this.registry.get(slug);
    if (!plugin) throw ApiError.notFound(`Plugin ${slug} not found`);

    const handlers = kind === 'query' ? plugin.queries : plugin.commands;
    const handler =
      handlers && Object.hasOwn(handlers, action)
        ? handlers[action]
        : undefined;
    if (!handler) {
      throw ApiError.notFound(`Plugin ${slug} has no ${kind} "${action}"`);
    }

    const payload = copyInput(input);
    const installation = await this.installations.resolve(
      consumer.username,
      plugin,
    );
    const output = await this.run(
      plugin,
      installation,
      consumer,
      `${kind} ${action}`,
      (ctx) => handler(ctx, payload),
      kind === 'query',
    );
    return { plugin: slug, action, output: copyOutput(plugin, action, output) };
  }

  /**
   * Delivers a core event to every installation of this consumer whose plugin
   * subscribes to it. Never throws: a plugin failing on an event is logged and
   * must not disturb the core flow, or the other plugins, that emitted it.
   */
  async dispatchEvent(
    consumerUsername: string,
    type: PluginEventType,
    data: unknown,
  ): Promise<void> {
    const subscribers = this.registry
      .list()
      .filter((p) => typeof p.events?.[type] === 'function');
    if (subscribers.length === 0) return;

    const targets = await this.installations.resolveAll(
      consumerUsername,
      subscribers,
    );
    const event = Object.freeze({ type, data: projectPaymentIntent(data) });

    for (const { plugin, installation, credentialId } of targets) {
      const handler = plugin.events?.[type];
      if (!handler) continue;
      // No request here, so the consumer is rebuilt from what is stored. The
      // credential id is the one on file: the core's consumer mirror upserts
      // it on every read, and a null here would erase the real one.
      const consumer: GatewayConsumer = {
        username: consumerUsername,
        credentialId,
        environment: null,
        role: 'user',
        permissions: [],
        organizationId: null,
        plan: null,
        planSwapFeeBps: null,
      };
      try {
        await this.run(plugin, installation, consumer, `event ${type}`, (ctx) =>
          handler(ctx, event),
        );
      } catch {
        // Already logged by `run`; the next subscriber still gets the event.
      }
    }
  }

  private async run<T>(
    plugin: PluginDefinition,
    installation: ResolvedInstallation,
    consumer: GatewayConsumer,
    label: string,
    body: (ctx: PluginContext) => T | Promise<T>,
    readOnly = false,
  ): Promise<T> {
    const lease = new InvocationLease(plugin.slug);
    const ctx = this.context(plugin, installation, consumer, lease, readOnly);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new PluginTimeoutError(
              `Plugin ${plugin.slug} did not finish ${label} within ${PLUGIN_INVOCATION_TIMEOUT_MS} ms`,
            ),
          ),
        PLUGIN_INVOCATION_TIMEOUT_MS,
      );
      timer.unref();
    });

    try {
      return await Promise.race([
        Promise.resolve().then(() => body(ctx)),
        timeout,
      ]);
    } catch (err) {
      throw this.toApiError(plugin, label, err);
    } finally {
      clearTimeout(timer);
      lease.revoke();
    }
  }

  private context(
    plugin: PluginDefinition,
    installation: ResolvedInstallation,
    consumer: GatewayConsumer,
    lease: InvocationLease,
    readOnly: boolean,
  ): PluginContext {
    const storage = this.storage.forInstallation(installation.id, plugin.slug);
    const core = this.core.forConsumer(
      consumer,
      installation.granted,
      plugin.slug,
    );
    // A query is served to `plugins:read` keys, so it must not be a write by
    // another name. Its context has the write methods, and they refuse.
    if (readOnly) {
      const refuse = (what: string) => () => {
        throw new PluginViolationError(
          `Plugin ${plugin.slug} tried to ${what} from a query; writes belong in a command`,
        );
      };
      storage.put = refuse('write storage');
      storage.delete = refuse('delete storage');
      core.customers.create = refuse('create a customer');
      core.customers.update = refuse('update a customer');
      core.products.create = refuse('create a product');
      core.products.update = refuse('update a product');
    }
    const http = this.http.forPlugin(plugin.slug, plugin.egress ?? []);
    const logger = new Logger(`plugin:${plugin.slug}`);

    return deepFreeze({
      plugin: { slug: plugin.slug, version: plugin.version },
      installation: { id: installation.id, config: installation.config },
      storage: leased(lease, storage),
      core: {
        customers: leased(lease, core.customers),
        products: leased(lease, core.products),
        paymentIntents: leased(lease, core.paymentIntents),
      },
      http: leased(lease, http),
      log: {
        log: (message: string) => logger.log(logLine(message)),
        warn: (message: string) => logger.warn(logLine(message)),
        error: (message: string) => logger.error(logLine(message)),
      },
    });
  }

  private toApiError(
    plugin: PluginDefinition,
    label: string,
    err: unknown,
  ): ApiError {
    const where = `Plugin ${plugin.slug} (${label})`;

    if (err instanceof PluginError) {
      return ApiError.badRequest(
        ApiErrorCode.PluginRejected,
        truncate(err.message),
      );
    }
    if (err instanceof PluginQuotaError) {
      return ApiError.conflict(ApiErrorCode.PluginQuotaExceeded, err.message);
    }
    // A core service refused what the plugin asked of it — a 4xx the plugin's
    // caller can act on, since it is their input the plugin passed along.
    if (err instanceof ApiError && err.getStatus() < 500) {
      return ApiError.badRequest(
        ApiErrorCode.PluginRejected,
        truncate(err.message),
      );
    }
    if (err instanceof PluginTimeoutError) {
      this.logger.warn(`${where}: ${err.message}`);
      return new ApiError(
        HttpStatus.GATEWAY_TIMEOUT,
        ApiErrorCode.PluginFailed,
        `Plugin ${plugin.slug} did not respond in time.`,
      );
    }
    if (err instanceof PluginViolationError) {
      this.logger.warn(`${where} refused: ${err.message}`);
    } else {
      this.logger.error(
        `${where} threw: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
    return ApiError.badGateway(
      ApiErrorCode.PluginFailed,
      `Plugin ${plugin.slug} failed while handling ${label.split(' ')[1] ?? label}.`,
    );
  }
}

/** Every method of `target`, charged against the lease before it runs. */
function leased<T extends object>(lease: InvocationLease, target: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(target)) {
    out[name] =
      typeof value === 'function'
        ? (...args: unknown[]) => {
            lease.spend();
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value;
  }
  return out as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** The action input as a detached plain object within the size cap. */
function copyInput(
  input: Record<string, unknown> | undefined,
): PluginJsonObject {
  const text = JSON.stringify(input ?? {});
  if (Buffer.byteLength(text) > PLUGIN_MAX_INPUT_BYTES) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      `input must be at most ${PLUGIN_MAX_INPUT_BYTES} bytes as JSON`,
    );
  }
  return deepFreeze(JSON.parse(text) as PluginJsonObject);
}

/** What the plugin returned, as JSON within the size cap — or a 502. */
function copyOutput(
  plugin: PluginDefinition,
  action: string,
  output: unknown,
): PluginJson {
  let text: string | undefined;
  try {
    text = JSON.stringify(output ?? null);
  } catch {
    text = undefined;
  }
  if (text === undefined || Buffer.byteLength(text) > PLUGIN_MAX_OUTPUT_BYTES) {
    throw ApiError.badGateway(
      ApiErrorCode.PluginFailed,
      `Plugin ${plugin.slug} failed while handling ${action}.`,
    );
  }
  return JSON.parse(text) as PluginJson;
}

function truncate(message: string): string {
  return message.length > PLUGIN_ERROR_MESSAGE_MAX
    ? `${message.slice(0, PLUGIN_ERROR_MESSAGE_MAX)}…`
    : message;
}

/** One line, bounded: a plugin does not get to forge extra log entries. */
function logLine(message: unknown): string {
  return String(message)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 1000);
}
