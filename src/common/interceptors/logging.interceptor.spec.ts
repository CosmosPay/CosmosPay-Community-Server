import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';

/**
 * These lock in two regressions that were silent by construction.
 *
 * 1. The interceptor read `response.statusCode` inside `finalize()`. On the
 *    error path `finalize` runs BEFORE AllExceptionsFilter writes the status, so
 *    every 4xx/5xx was persisted as the untouched default (200 for GET, 201 for
 *    POST). The API-log view could therefore never show an error.
 * 2. It returned early when `X-Cosmos-Internal` was present, so anyone able to
 *    set that header kept their traffic out of the audit log entirely.
 */
describe('LoggingInterceptor', () => {
  function build(
    headers: Record<string, string> = {},
    method = 'GET',
    responseStatus = 200,
  ) {
    const create = jest.fn().mockResolvedValue({});
    const prisma = { requestLog: { create } } as never;
    const interceptor = new LoggingInterceptor(prisma);

    const request = {
      method,
      url: '/v1/swaps?take=10',
      originalUrl: '/v1/swaps?take=10',
      headers,
      ip: '203.0.113.7',
      gatewayConsumer: { username: 'cosmos_u1' },
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ statusCode: responseStatus }),
      }),
    } as unknown as ExecutionContext;

    return { interceptor, context, create };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  /** The persist() write is fire-and-forget, so let the microtask queue drain. */
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('records the response status for a successful request', async () => {
    const { interceptor, context, create } = build();
    const next: CallHandler = { handle: () => of({ ok: true }) };

    await firstValueFrom(interceptor.intercept(context, next));
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({
      statusCode: 200,
      method: 'GET',
      path: '/v1/swaps',
      consumer: 'cosmos_u1',
    });
  });

  it('records the exception status, not the untouched response default', async () => {
    // A POST whose response object still reads 201 while the request 400s.
    const { interceptor, context, create } = build({}, 'POST', 201);
    const next: CallHandler = {
      handle: () => throwError(() => new BadRequestException('slippage')),
    };

    await expect(
      firstValueFrom(interceptor.intercept(context, next)),
    ).rejects.toBeInstanceOf(BadRequestException);
    await flush();

    expect(create.mock.calls[0][0].data.statusCode).toBe(400);
  });

  it('records 404 for a NotFoundException', async () => {
    const { interceptor, context, create } = build();
    const next: CallHandler = {
      handle: () => throwError(() => new NotFoundException('nope')),
    };

    await expect(
      firstValueFrom(interceptor.intercept(context, next)),
    ).rejects.toBeInstanceOf(NotFoundException);
    await flush();

    expect(create.mock.calls[0][0].data.statusCode).toBe(404);
  });

  it('records 500 for a non-HTTP error', async () => {
    const { interceptor, context, create } = build();
    const next: CallHandler = {
      handle: () => throwError(() => new Error('boom')),
    };

    await expect(
      firstValueFrom(interceptor.intercept(context, next)),
    ).rejects.toThrow('boom');
    await flush();

    expect(create.mock.calls[0][0].data.statusCode).toBe(500);
  });

  it('still writes a row for internal traffic, flagged rather than skipped', async () => {
    const { interceptor, context, create } = build({
      'x-cosmos-internal': '1',
    });
    const next: CallHandler = { handle: () => of({ ok: true }) };

    await firstValueFrom(interceptor.intercept(context, next));
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.internal).toBe(true);
  });

  it('marks ordinary traffic as not internal', async () => {
    const { interceptor, context, create } = build();
    const next: CallHandler = { handle: () => of({ ok: true }) };

    await firstValueFrom(interceptor.intercept(context, next));
    await flush();

    expect(create.mock.calls[0][0].data.internal).toBe(false);
  });

  it('skips health and docs traffic entirely', async () => {
    for (const url of ['/v1/health/liveness', '/docs/json']) {
      const create = jest.fn().mockResolvedValue({});
      const interceptor = new LoggingInterceptor({
        requestLog: { create },
      } as never);
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'GET',
            url,
            originalUrl: url,
            headers: {},
            ip: null,
          }),
          getResponse: () => ({ statusCode: 200 }),
        }),
      } as unknown as ExecutionContext;

      await firstValueFrom(
        interceptor.intercept(context, { handle: () => of(null) }),
      );
      await flush();

      expect(create).not.toHaveBeenCalled();
    }
  });

  it('never fails the request when the log write rejects', async () => {
    const create = jest.fn().mockRejectedValue(new Error('db down'));
    const interceptor = new LoggingInterceptor({
      requestLog: { create },
    } as never);
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          url: '/v1/swaps',
          originalUrl: '/v1/swaps',
          headers: {},
          ip: null,
        }),
        getResponse: () => ({ statusCode: 200 }),
      }),
    } as unknown as ExecutionContext;

    await expect(
      firstValueFrom(interceptor.intercept(context, { handle: () => of(1) })),
    ).resolves.toBe(1);
    await flush();
  });
});
