import { lastValueFrom, of } from 'rxjs';
import { ApiError } from '@/common/errors/api-error';
import { PluginConcurrencyInterceptor } from '@/plugins/plugin-concurrency.interceptor';
import { PluginConcurrencyService } from '@/plugins/plugin-concurrency.service';
import {
  PLUGIN_MAX_CONCURRENT_EVENTS_PER_CONSUMER,
  PLUGIN_MAX_CONCURRENT_INVOCATIONS,
  PLUGIN_MAX_CONCURRENT_INVOCATIONS_PER_CONSUMER,
  PLUGIN_MAX_PENDING_EVENTS_PER_CONSUMER,
} from '@/plugins/plugins.constants';

describe('PluginConcurrencyService', () => {
  it('caps the actions one consumer runs at once, without touching another', () => {
    const concurrency = new PluginConcurrencyService();
    const held = Array.from(
      { length: PLUGIN_MAX_CONCURRENT_INVOCATIONS_PER_CONSUMER },
      () => concurrency.tryEnterAction('a'),
    );
    expect(held.every(Boolean)).toBe(true);
    expect(concurrency.tryEnterAction('a')).toBeNull();
    expect(concurrency.tryEnterAction('b')).not.toBeNull();

    held[0]!();
    expect(concurrency.tryEnterAction('a')).not.toBeNull();
  });

  it('caps the process across consumers', () => {
    const concurrency = new PluginConcurrencyService();
    for (let i = 0; i < PLUGIN_MAX_CONCURRENT_INVOCATIONS; i++) {
      expect(concurrency.tryEnterAction(`c${i}`)).not.toBeNull();
    }
    expect(concurrency.tryEnterAction('late')).toBeNull();
  });

  it('gives a slot back once however often release is called', () => {
    const concurrency = new PluginConcurrencyService();
    const release = concurrency.tryEnterAction('a')!;
    release();
    release();
    expect(concurrency.inFlight).toBe(0);
  });

  it('makes an event wait for a slot instead of refusing it', async () => {
    const concurrency = new PluginConcurrencyService();
    const releases = Array.from(
      { length: PLUGIN_MAX_CONCURRENT_INVOCATIONS },
      (_, i) => concurrency.tryEnterAction(`c${i}`)!,
    );
    let entered = false;
    const event = concurrency.enterEvent('cosmos_u1').then((release) => {
      entered = true;
      return release;
    });
    await Promise.resolve();
    expect(entered).toBe(false);

    releases[0]();
    (await event)!();
    expect(entered).toBe(true);
  });

  it('runs a consumer’s events within its own share, leaving the process to others', async () => {
    const concurrency = new PluginConcurrencyService();
    const held = await Promise.all(
      Array.from({ length: PLUGIN_MAX_CONCURRENT_EVENTS_PER_CONSUMER }, () =>
        concurrency.enterEvent('burst'),
      ),
    );
    let next = false;
    const queued = concurrency.enterEvent('burst').then((release) => {
      next = true;
      return release;
    });
    await Promise.resolve();
    // The burst waits behind itself; the process still has slots for others.
    expect(next).toBe(false);
    expect(concurrency.inFlight).toBe(
      PLUGIN_MAX_CONCURRENT_EVENTS_PER_CONSUMER,
    );
    expect(concurrency.tryEnterAction('someone-else')).not.toBeNull();

    held[0]!();
    (await queued)!();
    expect(next).toBe(true);
  });

  it('drops a consumer’s event once too many are pending', async () => {
    const concurrency = new PluginConcurrencyService();
    const pending = Array.from(
      { length: PLUGIN_MAX_PENDING_EVENTS_PER_CONSUMER },
      () => concurrency.enterEvent('burst'),
    );
    await expect(concurrency.enterEvent('burst')).resolves.toBeNull();
    await expect(concurrency.enterEvent('other')).resolves.not.toBeNull();
    void pending;
  });
});

describe('PluginConcurrencyInterceptor', () => {
  function context(username = 'cosmos_u1') {
    const headers: Record<string, unknown> = {};
    return {
      headers,
      ctx: {
        switchToHttp: () => ({
          getRequest: () => ({ gatewayConsumer: { username } }),
          getResponse: () => ({
            setHeader: (name: string, value: unknown) => {
              headers[name] = value;
            },
          }),
        }),
      } as any,
    };
  }

  it('holds the slot for the request and gives it back when it ends', async () => {
    const concurrency = new PluginConcurrencyService();
    const interceptor = new PluginConcurrencyInterceptor(concurrency);
    let during = -1;
    await lastValueFrom(
      interceptor.intercept(context().ctx, {
        handle: () => {
          during = concurrency.inFlight;
          return of('ok');
        },
      }),
    );
    expect(during).toBe(1);
    expect(concurrency.inFlight).toBe(0);
  });

  it('answers 429 rate_limited with Retry-After when the consumer is at its cap', async () => {
    const concurrency = new PluginConcurrencyService();
    for (let i = 0; i < PLUGIN_MAX_CONCURRENT_INVOCATIONS_PER_CONSUMER; i++) {
      concurrency.tryEnterAction('cosmos_u1');
    }
    const interceptor = new PluginConcurrencyInterceptor(concurrency);
    const handle = jest.fn(() => of('ok'));
    const { ctx, headers } = context();

    const err = await lastValueFrom(
      interceptor.intercept(ctx, { handle }),
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).getStatus()).toBe(429);
    expect((err as ApiError).getResponse()).toMatchObject({
      code: 'rate_limited',
    });
    expect(headers['retry-after']).toBe(1);
    expect(handle).not.toHaveBeenCalled();
  });
});
