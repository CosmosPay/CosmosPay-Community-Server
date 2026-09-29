import { ApiError } from '@/common/errors/api-error';
import { PluginQuotaError } from '@/plugins/plugin-errors';
import { PluginRuntimeService } from '@/plugins/plugin-runtime.service';
import {
  PLUGIN_INVOCATION_TIMEOUT_MS,
  PLUGIN_MAX_CALLS_PER_INVOCATION,
} from '@/plugins/plugins.constants';
import {
  definePlugin,
  PluginError,
  type PluginContext,
  type PluginDefinition,
} from '@/plugins/sdk';

const consumer = { username: 'cosmos_u1', credentialId: 'cred_1' } as any;

function build(plugin: PluginDefinition) {
  const registry = {
    get: jest.fn((slug: string) => (slug === plugin.slug ? plugin : undefined)),
    list: jest.fn(() => [plugin]),
  };
  const installation = {
    id: 'inst_1',
    granted: new Set(plugin.capabilities),
    config: Object.freeze({ region: 'eu' }),
  };
  const installations = {
    resolve: jest.fn().mockResolvedValue(installation),
    resolveAll: jest
      .fn()
      .mockResolvedValue([{ plugin, installation, credentialId: 'cred_1' }]),
  };
  const store = {
    get: jest.fn().mockResolvedValue(null),
    put: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };
  const storage = { forInstallation: jest.fn(() => ({ ...store })) };
  const customers = {
    list: jest.fn(),
    get: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 'cus_1' }),
    update: jest.fn(),
  };
  const core = {
    forConsumer: jest.fn(() => ({
      customers: { ...customers },
      products: {
        list: jest.fn(),
        get: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      paymentIntents: { list: jest.fn(), get: jest.fn() },
    })),
  };
  const http = { forPlugin: jest.fn(() => ({ request: jest.fn() })) };
  const runtime = new PluginRuntimeService(
    registry as any,
    installations as any,
    storage as any,
    core as any,
    http as any,
  );
  return { runtime, installations, store, customers, core };
}

function plugin(
  handlers: Pick<PluginDefinition, 'queries' | 'commands' | 'events'>,
  capabilities: PluginDefinition['capabilities'] = ['customers:write'],
) {
  return definePlugin({
    slug: 'acme',
    name: 'Acme',
    version: '1.0.0',
    description: 'd',
    author: 'a',
    capabilities,
    ...handlers,
  });
}

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected an ApiError');
}

describe('PluginRuntimeService.invoke', () => {
  it('runs the action with the tenant installation and returns its JSON', async () => {
    const { runtime, installations, core } = build(
      plugin({
        commands: {
          hello: (ctx, input) => ({
            slug: ctx.plugin.slug,
            region: ctx.installation.config.region,
            echo: input.name ?? null,
          }),
        },
      }),
    );

    const result = await runtime.invoke(consumer, 'acme', 'command', 'hello', {
      name: 'Ada',
    });

    expect(result).toEqual({
      plugin: 'acme',
      action: 'hello',
      output: { slug: 'acme', region: 'eu', echo: 'Ada' },
    });
    expect(installations.resolve).toHaveBeenCalledWith(
      'cosmos_u1',
      expect.objectContaining({ slug: 'acme' }),
    );
    expect(core.forConsumer).toHaveBeenCalledWith(
      consumer,
      new Set(['customers:write']),
      'acme',
    );
  });

  it('404s an unknown plugin, an unknown action, and a query called as a command', async () => {
    const { runtime } = build(plugin({ queries: { read: () => 1 } }));

    expect(
      (
        await apiError(runtime.invoke(consumer, 'nope', 'query', 'read', {}))
      ).getStatus(),
    ).toBe(404);
    expect(
      (
        await apiError(runtime.invoke(consumer, 'acme', 'query', 'nope', {}))
      ).getStatus(),
    ).toBe(404);
    expect(
      (
        await apiError(runtime.invoke(consumer, 'acme', 'command', 'read', {}))
      ).getStatus(),
    ).toBe(404);
    // Inherited members of the handler map are not actions.
    expect(
      (
        await apiError(
          runtime.invoke(consumer, 'acme', 'query', 'toString', {}),
        )
      ).getStatus(),
    ).toBe(404);
  });

  it('turns a PluginError into 400 plugin_rejected, with its message', async () => {
    const { runtime } = build(
      plugin({
        commands: {
          fail: () => {
            throw new PluginError('customerId is required');
          },
        },
      }),
    );

    const err = await apiError(
      runtime.invoke(consumer, 'acme', 'command', 'fail', {}),
    );
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({
      code: 'plugin_rejected',
      message: 'customerId is required',
    });
  });

  it('turns a crash into 502 plugin_failed without leaking the detail', async () => {
    const { runtime } = build(
      plugin({
        commands: {
          crash: () => {
            throw new Error('db password is hunter2');
          },
        },
      }),
    );

    const err = await apiError(
      runtime.invoke(consumer, 'acme', 'command', 'crash', {}),
    );
    expect(err.getStatus()).toBe(502);
    expect(JSON.stringify(err.getResponse())).not.toContain('hunter2');
  });

  it('maps a storage quota to 409 plugin_quota_exceeded', async () => {
    const { runtime, store } = build(
      plugin({
        commands: {
          save: async (ctx) => {
            await ctx.storage.put('c', 'k', 1);
            return null;
          },
        },
      }),
    );
    store.put.mockRejectedValue(new PluginQuotaError('full'));

    const err = await apiError(
      runtime.invoke(consumer, 'acme', 'command', 'save', {}),
    );
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: 'plugin_quota_exceeded' });
  });

  it('refuses every write from a query', async () => {
    const { runtime, store, customers } = build(
      plugin({
        queries: {
          sneaky: async (ctx) => {
            await ctx.storage.put('c', 'k', 1);
            return null;
          },
          sneakyCore: async (ctx) => {
            await ctx.core.customers.create({ name: 'x' });
            return null;
          },
        },
      }),
    );

    for (const action of ['sneaky', 'sneakyCore']) {
      const err = await apiError(
        runtime.invoke(consumer, 'acme', 'query', action, {}),
      );
      expect(err.getStatus()).toBe(502);
    }
    expect(store.put).not.toHaveBeenCalled();
    expect(customers.create).not.toHaveBeenCalled();
  });

  it('caps the context calls one invocation may make', async () => {
    const { runtime, store } = build(
      plugin({
        queries: {
          loop: async (ctx) => {
            for (let i = 0; i <= PLUGIN_MAX_CALLS_PER_INVOCATION; i++) {
              await ctx.storage.get('c', `k${i}`);
            }
            return null;
          },
        },
      }),
    );

    const err = await apiError(
      runtime.invoke(consumer, 'acme', 'query', 'loop', {}),
    );
    expect(err.getStatus()).toBe(502);
    expect(store.get).toHaveBeenCalledTimes(PLUGIN_MAX_CALLS_PER_INVOCATION);
  });

  it('hands the plugin a frozen context and a frozen input', async () => {
    let seen: PluginContext | undefined;
    const { runtime } = build(
      plugin({
        queries: {
          look: (ctx, input) => {
            seen = ctx;
            expect(Object.isFrozen(input)).toBe(true);
            return null;
          },
        },
      }),
    );

    await runtime.invoke(consumer, 'acme', 'query', 'look', { a: 1 });

    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen?.storage)).toBe(true);
    expect(() => {
      (seen!.storage as any).get = () => null;
    }).toThrow(TypeError);
  });

  describe('timeouts', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('answers 504 and revokes the context the plugin left running', async () => {
      let ctxRef: PluginContext | undefined;
      const { runtime, store } = build(
        plugin({
          commands: {
            hang: (ctx) => {
              ctxRef = ctx;
              return new Promise(() => undefined);
            },
          },
        }),
      );

      const pending = apiError(
        runtime.invoke(consumer, 'acme', 'command', 'hang', {}),
      );
      await jest.advanceTimersByTimeAsync(PLUGIN_INVOCATION_TIMEOUT_MS + 1);
      const err = await pending;

      expect(err.getStatus()).toBe(504);
      expect(err.getResponse()).toMatchObject({ code: 'plugin_failed' });
      expect(() => ctxRef!.storage.put('c', 'k', 1)).toThrow(
        /after the invocation ended/,
      );
      expect(store.put).not.toHaveBeenCalled();
    });
  });

  it('refuses an output that is not JSON', async () => {
    const cyclic: any = {};
    cyclic.self = cyclic;
    const { runtime } = build(plugin({ queries: { bad: () => cyclic } }));

    const err = await apiError(
      runtime.invoke(consumer, 'acme', 'query', 'bad', {}),
    );
    expect(err.getStatus()).toBe(502);
  });
});

describe('PluginRuntimeService.dispatchEvent', () => {
  it('delivers the projected intent to subscribers and swallows their failures', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('boom'));
    const { runtime, core } = build(
      plugin({ events: { PAYMENT_INTENT_SUCCEEDED: handler } }, [
        'payment_intents:read',
      ]),
    );

    await expect(
      runtime.dispatchEvent('cosmos_u1', 'PAYMENT_INTENT_SUCCEEDED', {
        id: 'pi_1',
        consumerId: 'c_internal',
        xdr: 'AAAA',
      }),
    ).resolves.toBeUndefined();

    const event = handler.mock.calls[0][1];
    expect(event.type).toBe('PAYMENT_INTENT_SUCCEEDED');
    expect(event.data.id).toBe('pi_1');
    expect(event.data).not.toHaveProperty('consumerId');
    expect(event.data).not.toHaveProperty('xdr');
    // The consumer is rebuilt with the stored credential id, never null.
    expect(core.forConsumer).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'cosmos_u1',
        credentialId: 'cred_1',
      }),
      expect.any(Set),
      'acme',
    );
  });

  it('does not look installations up for an event nobody subscribes to', async () => {
    const { runtime, installations } = build(plugin({}));
    await runtime.dispatchEvent('cosmos_u1', 'PAYMENT_INTENT_CREATED', {});
    expect(installations.resolveAll).not.toHaveBeenCalled();
  });
});
