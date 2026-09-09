import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import { Reflector } from '@nestjs/core';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { PublicKeyGuard } from '@/common/guards/public-key.guard';
import { ALLOW_PUBLIC_KEY } from '@/common/decorators/allow-public-key.decorator';
import { IS_PUBLIC_KEY } from '@/common/decorators/public.decorator';

/**
 * The shared public key is one credential held by every anonymous wallet on the
 * network, so the thing under test is a tenancy boundary, not a permission: the
 * scopes it needs to price a swap (`swaps:read`) are the same ones that list
 * every anonymous user's swap history. Nothing else in the suite exercises that
 * overlap — the e2e suites all authenticate as a private consumer, where the two
 * meanings of `swaps:read` coincide and the bug is invisible.
 */
describe('PublicKeyGuard', () => {
  const PUBLIC_CONSUMER = 'cosmos_public';

  type Meta = Partial<{
    [ALLOW_PUBLIC_KEY]: boolean;
    [IS_PUBLIC_KEY]: boolean;
  }>;

  function build(
    meta: Meta,
    consumer: unknown,
    publicConsumer: string = PUBLIC_CONSUMER,
  ) {
    const reflector = {
      getAllAndOverride: (key: string) =>
        (meta as Record<string, unknown>)[key],
    } as unknown as Reflector;
    const config = {
      get: () => ({ publicConsumer }),
    } as unknown as ConfigService<AppConfig, true>;
    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          url: '/v1/swaps',
          gatewayConsumer: consumer,
        }),
      }),
    } as unknown as ExecutionContext;
    return { guard: new PublicKeyGuard(reflector, config), context };
  }

  const consumer = (
    over: Partial<{ username: string; role: string | null }> = {},
  ) => ({
    username: over.username ?? PUBLIC_CONSUMER,
    credentialId: 'cred_1',
    environment: 'prod',
    role: over.role === undefined ? 'public' : over.role,
    permissions: ['swaps:read', 'swaps:write'],
    organizationId: null,
    plan: 'community',
    planSwapFeeBps: 150,
  });

  function denial(guard: PublicKeyGuard, context: ExecutionContext) {
    try {
      guard.canActivate(context);
    } catch (err) {
      return err as ApiError;
    }
    throw new Error('expected the guard to deny');
  }

  it('refuses the public key on a route that does not admit it', () => {
    const { guard, context } = build({}, consumer());
    const err = denial(guard, context);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
  });

  it('names the account upgrade in the refusal, since that is the fix', () => {
    const { guard, context } = build({}, consumer());
    // The message reaches an end user inside a wallet, not only a log: it has to
    // say what to do about it, and the lower commission is the actual incentive.
    expect(denial(guard, context).message).toContain('CosmosPay account');
  });

  it('uses InsufficientScope so clients keep one code to branch on', () => {
    const { guard, context } = build({}, consumer());
    expect(denial(guard, context).code).toBe(ApiErrorCode.InsufficientScope);
  });

  it('admits the public key on a route marked @AllowPublicKey', () => {
    const { guard, context } = build({ [ALLOW_PUBLIC_KEY]: true }, consumer());
    expect(guard.canActivate(context)).toBe(true);
  });

  /**
   * The independence of the two signals is the point of having both. Each of the
   * next two cases removes one and expects the refusal to stand.
   */
  it('still refuses when the role header is missing, matching on username', () => {
    // A gateway upgrade that drops `X-Consumer-Role` makes every public caller
    // look like an ordinary tenant. Username alone has to carry the refusal.
    const { guard, context } = build({}, consumer({ role: 'user' }));
    expect(denial(guard, context).getStatus()).toBe(HttpStatus.FORBIDDEN);
  });

  it('still refuses when APISIX_PUBLIC_CONSUMER is unset, matching on role', () => {
    const { guard, context } = build(
      {},
      consumer({ username: 'cosmos_something_else' }),
      '',
    );
    expect(denial(guard, context).getStatus()).toBe(HttpStatus.FORBIDDEN);
  });

  it('lets an ordinary consumer through untouched', () => {
    const { guard, context } = build(
      {},
      consumer({ username: 'cosmos_u1', role: 'user' }),
    );
    expect(guard.canActivate(context)).toBe(true);
  });

  it('lets an admin key through — it is not the shared credential', () => {
    const { guard, context } = build(
      {},
      consumer({ username: 'cosmos_u1', role: 'admin' }),
    );
    expect(guard.canActivate(context)).toBe(true);
  });

  it('skips @Public() routes, which have no consumer at all', () => {
    const { guard, context } = build({ [IS_PUBLIC_KEY]: true }, undefined);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('passes a request with no consumer to the guards that reject it', () => {
    // ApisixGuard owns that refusal; duplicating it here would mean two places
    // decide what an unauthenticated request is.
    const { guard, context } = build({}, undefined);
    expect(guard.canActivate(context)).toBe(true);
  });
});
