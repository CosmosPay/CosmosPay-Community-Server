import { Reflector } from '@nestjs/core';
import { RATE_LIMIT_KEY } from '@/common/decorators/rate-limit.decorator';
import { RateLimitGuard } from '@/common/guards/rate-limit.guard';

const POLICY = { name: 'pollar:authorize', limit: 20, windowMs: 600_000 };

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
  opts: { policy?: any; enabled?: boolean; outcome?: any } = {},
) {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    // `??` would defeat the "no policy" case, since that passes an explicit
    // undefined — ask whether the key was supplied at all.
    .mockImplementation((key: string) =>
      key === RATE_LIMIT_KEY
        ? 'policy' in opts
          ? opts.policy
          : POLICY
        : undefined,
    );
  const limiter: any = {
    hit: jest.fn().mockResolvedValue(
      opts.outcome ?? {
        allowed: true,
        limit: 20,
        remaining: 19,
        resetAt: new Date(Date.now() + 60_000),
      },
    ),
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
      outcome: {
        allowed: false,
        limit: 20,
        remaining: 0,
        resetAt: new Date(Date.now() + 30_000),
      },
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
    const { guard, limiter } = makeGuard({ policy: undefined });
    const { context } = makeContext({ ip: '203.0.113.7' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    // No counter write for the routes that did not ask to be limited.
    expect(limiter.hit).not.toHaveBeenCalled();
  });

  it('does nothing when the limiter is switched off', async () => {
    const { guard, limiter } = makeGuard({ enabled: false });
    const { context } = makeContext({ ip: '203.0.113.7' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(limiter.hit).not.toHaveBeenCalled();
  });
});
