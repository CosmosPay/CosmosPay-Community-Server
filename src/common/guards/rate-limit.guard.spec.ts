import { Reflector } from '@nestjs/core';
import { RATE_LIMIT_KEY } from '@/common/decorators/rate-limit.decorator';
import { RateLimitGuard } from '@/common/guards/rate-limit.guard';

const POLICY = { name: 'pollar:authorize', limit: 20, windowMs: 600_000 };
const CEILING = {
  name: 'pollar:wallets:daily',
  limit: 50,
  windowMs: 86_400_000,
  per: 'consumer' as const,
};

const allowed = (limit: number, remaining: number) => ({
  allowed: true,
  limit,
  remaining,
  resetAt: new Date(Date.now() + 60_000),
});

function makeContext(request: any) {
  const response = { setHeader: jest.fn() };
  return {
    response,
    context: {
      getHandler: () => 'handler',
      getClass: () => 'class',
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as any,
  };
}

function makeGuard(
  opts: { policies?: any; enabled?: boolean; outcomes?: any[] } = {},
) {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    // `??` would defeat the "no policy" case, since that passes an explicit
    // undefined — ask whether the key was supplied at all.
    .mockImplementation((key: unknown) =>
      key === RATE_LIMIT_KEY
        ? 'policies' in opts
          ? opts.policies
          : [POLICY]
        : undefined,
    );
  const outcomes = [...(opts.outcomes ?? [])];
  const limiter: any = {
    hit: jest.fn(() => Promise.resolve(outcomes.shift() ?? allowed(20, 19))),
  };
  const config: any = {
    get: jest.fn(() => ({ enabled: opts.enabled ?? true })),
  };
  return { guard: new RateLimitGuard(reflector, limiter, config), limiter };
}

describe('RateLimitGuard', () => {
  it('keys on the consumer and the client address', async () => {
    const { guard, limiter } = makeGuard();
    const { context } = makeContext({
      ip: '203.0.113.7',
      gatewayConsumer: { username: 'cosmos_acme' },
    });

    await guard.canActivate(context);

    expect(limiter.hit).toHaveBeenCalledWith('cosmos_acme:203.0.113.7', POLICY);
  });

  it('buckets an IPv6 caller by /64', async () => {
    const { guard, limiter } = makeGuard();
    const { context } = makeContext({
      ip: '2001:db8:1:2:aaaa::1',
      gatewayConsumer: { username: 'cosmos_acme' },
    });

    await guard.canActivate(context);

    expect(limiter.hit).toHaveBeenCalledWith(
      'cosmos_acme:2001:db8:1:2::/64',
      POLICY,
    );
  });

  it('keys an unauthenticated caller under `anonymous`', async () => {
    // The public callback has no consumer, so it must still get a bucket rather
    // than sharing one with whatever the last authenticated caller was.
    const { guard, limiter } = makeGuard();
    const { context } = makeContext({ ip: '203.0.113.7' });

    await guard.canActivate(context);

    expect(limiter.hit).toHaveBeenCalledWith('anonymous:203.0.113.7', POLICY);
  });

  it('refuses with 429 and a Retry-After once the budget is spent', async () => {
    const { guard } = makeGuard({
      outcomes: [
        {
          allowed: false,
          limit: 20,
          remaining: 0,
          resetAt: new Date(Date.now() + 30_000),
        },
      ],
    });
    const { context, response } = makeContext({ ip: '203.0.113.7' });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
    });
    expect(response.setHeader).toHaveBeenCalledWith(
      'retry-after',
      expect.any(Number),
    );
  });

  it('reports the budget on a request it allows', async () => {
    const { guard } = makeGuard();
    const { context, response } = makeContext({ ip: '203.0.113.7' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(response.setHeader).toHaveBeenCalledWith('ratelimit-limit', 20);
    expect(response.setHeader).toHaveBeenCalledWith('ratelimit-remaining', 19);
  });

  it('passes a route with no policy straight through', async () => {
    for (const policies of [undefined, []]) {
      const { guard, limiter } = makeGuard({ policies });
      const { context } = makeContext({ ip: '203.0.113.7' });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      // No counter write for the routes that did not ask to be limited.
      expect(limiter.hit).not.toHaveBeenCalled();
    }
  });

  it('does nothing when the limiter is switched off', async () => {
    const { guard, limiter } = makeGuard({ enabled: false });
    const { context } = makeContext({ ip: '203.0.113.7' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(limiter.hit).not.toHaveBeenCalled();
  });

  describe('stacked budgets', () => {
    it('counts a per-consumer ceiling on the consumer alone', async () => {
      // Rotating addresses is exactly what a per-address budget cannot see, so
      // the ceiling's subject must not contain one.
      const { guard, limiter } = makeGuard({ policies: [POLICY, CEILING] });
      for (const ip of ['203.0.113.7', '198.51.100.9']) {
        const { context } = makeContext({
          ip,
          gatewayConsumer: { username: 'cosmos_acme' },
        });
        await guard.canActivate(context);
      }

      expect(limiter.hit).toHaveBeenCalledWith(
        'cosmos_acme:203.0.113.7',
        POLICY,
      );
      expect(limiter.hit).toHaveBeenCalledWith(
        'cosmos_acme:198.51.100.9',
        POLICY,
      );
      expect(
        limiter.hit.mock.calls.filter(([, policy]: any) => policy === CEILING),
      ).toEqual([
        ['cosmos_acme', CEILING],
        ['cosmos_acme', CEILING],
      ]);
    });

    it('refuses once any budget is spent, even with the address budget left', async () => {
      const { guard } = makeGuard({
        policies: [POLICY, CEILING],
        outcomes: [
          allowed(20, 19),
          {
            allowed: false,
            limit: 50,
            remaining: 0,
            resetAt: new Date(Date.now() + 3_600_000),
          },
        ],
      });
      const { context, response } = makeContext({
        ip: '203.0.113.7',
        gatewayConsumer: { username: 'cosmos_acme' },
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        status: 429,
      });
      // The headers describe the budget that refused, not the one with room.
      expect(response.setHeader).toHaveBeenCalledWith('ratelimit-limit', 50);
      expect(response.setHeader).toHaveBeenCalledWith('ratelimit-remaining', 0);
    });

    it('reports the tighter of two budgets it allows', async () => {
      const { guard } = makeGuard({
        policies: [POLICY, CEILING],
        outcomes: [allowed(20, 19), allowed(50, 3)],
      });
      const { context, response } = makeContext({
        ip: '203.0.113.7',
        gatewayConsumer: { username: 'cosmos_acme' },
      });

      await guard.canActivate(context);

      expect(response.setHeader).toHaveBeenCalledWith('ratelimit-limit', 50);
      expect(response.setHeader).toHaveBeenCalledWith('ratelimit-remaining', 3);
      expect(response.setHeader).not.toHaveBeenCalledWith(
        'ratelimit-remaining',
        19,
      );
    });

    it('exempts a console call from per-consumer ceilings only', async () => {
      // The dev platform brokers every keyless wallet through one consumer; its
      // per-address budgets still apply, the shared ceiling does not.
      const { guard, limiter } = makeGuard({ policies: [POLICY, CEILING] });
      const { context } = makeContext({
        ip: '203.0.113.7',
        gatewayConsumer: { username: 'cosmos_broker', internal: true },
      });

      await guard.canActivate(context);

      expect(limiter.hit).toHaveBeenCalledTimes(1);
      expect(limiter.hit).toHaveBeenCalledWith(
        'cosmos_broker:203.0.113.7',
        POLICY,
      );
    });
  });
});
