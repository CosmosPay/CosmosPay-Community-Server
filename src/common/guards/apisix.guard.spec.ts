import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { ApisixGuard } from '@/common/guards/apisix.guard';

const SECRET = 'topsecret-topsecret-topsecret-topsecret';

function build({ isPublic = false } = {}) {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(isPublic),
  } as unknown as Reflector;
  const config = {
    get: jest.fn().mockReturnValue({
      gatewaySecret: SECRET,
      gatewaySecretHeader: 'x-gateway-secret',
    }),
  };
  return new ApisixGuard(reflector, config as never);
}

function ctx(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (e) {
    return e instanceof ApiError ? e.code : `THREW:${String(e)}`;
  }
}

const consumer = { username: 'cosmos_u1' };

describe('ApisixGuard', () => {
  it('admits the gateway secret plus an authenticated consumer', () => {
    const request = {
      method: 'GET',
      url: '/v1/swaps',
      headers: { 'x-gateway-secret': SECRET },
      gatewayConsumer: consumer,
    };
    expect(build().canActivate(ctx(request))).toBe(true);
    expect(request.gatewayConsumer).toBe(consumer);
  });

  it('refuses a request with no gateway secret', () => {
    expect(
      codeOf(() =>
        build().canActivate(
          ctx({
            method: 'GET',
            url: '/',
            headers: {},
            gatewayConsumer: consumer,
          }),
        ),
      ),
    ).toBe(ApiErrorCode.GatewayRequired);
  });

  it('refuses a wrong secret of the same length and of a different length', () => {
    // The different-length case must be a refusal, not a RangeError out of
    // timingSafeEqual — that would be a 500 on every probe.
    for (const provided of [SECRET.replace(/t/g, 'x'), 'short']) {
      expect(
        codeOf(() =>
          build().canActivate(
            ctx({
              method: 'GET',
              url: '/',
              headers: { 'x-gateway-secret': provided },
              gatewayConsumer: consumer,
            }),
          ),
        ),
      ).toBe(ApiErrorCode.GatewayRequired);
    }
  });

  it('refuses the secret without an authenticated consumer', () => {
    expect(
      codeOf(() =>
        build().canActivate(
          ctx({
            method: 'GET',
            url: '/',
            headers: { 'x-gateway-secret': SECRET },
          }),
        ),
      ),
    ).toBe(ApiErrorCode.NoAuthenticatedConsumer);
  });

  it('reads only the first value of a repeated secret header', () => {
    expect(
      build().canActivate(
        ctx({
          method: 'GET',
          url: '/',
          headers: { 'x-gateway-secret': [SECRET, 'junk'] },
          gatewayConsumer: consumer,
        }),
      ),
    ).toBe(true);
  });

  describe('@Public() routes', () => {
    it('admits a request with no secret at all', () => {
      expect(
        build({ isPublic: true }).canActivate(
          ctx({ method: 'GET', url: '/v1/health', headers: {} }),
        ),
      ).toBe(true);
    });

    it('drops a consumer the caller supplied, so it cannot pick a rate-limit bucket or a tenant log', () => {
      // These routes run without key-auth, so X-Consumer-Username arrives exactly
      // as the client typed it.
      const request: Record<string, unknown> = {
        method: 'GET',
        url: '/v1/pollar/oauth/callback/abc',
        headers: { 'x-consumer-username': 'cosmos_victim' },
        gatewayConsumer: { username: 'cosmos_victim' },
      };
      expect(build({ isPublic: true }).canActivate(ctx(request))).toBe(true);
      expect(request).not.toHaveProperty('gatewayConsumer');
    });
  });
});
