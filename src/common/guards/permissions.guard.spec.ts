import { ExecutionContext, HttpStatus, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { PermissionsGuard } from '@/common/guards/permissions.guard';
import {
  ANY_PERMISSIONS_KEY,
  PERMISSIONS_KEY,
} from '@/common/decorators/require-permissions.decorator';
import { IS_PUBLIC_KEY } from '@/common/decorators/public.decorator';

/**
 * The scope system had no test of any kind, and every e2e suite forwards the
 * complete scope set — so the deny path never executed anywhere in the suite.
 * Dropping a `@RequirePermissions` decorator, or widening the admin bypass,
 * would have shipped green: a `webhooks:read` key could rotate signing secrets.
 */
describe('PermissionsGuard', () => {
  type Meta = Partial<{
    [PERMISSIONS_KEY]: string[];
    [ANY_PERMISSIONS_KEY]: string[];
    [IS_PUBLIC_KEY]: boolean;
  }>;

  function build(meta: Meta, consumer: unknown) {
    const reflector = {
      getAllAndOverride: (key: string) =>
        (meta as Record<string, unknown>)[key],
    } as unknown as Reflector;
    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          url: '/v1/webhooks',
          gatewayConsumer: consumer,
        }),
      }),
    } as unknown as ExecutionContext;
    return { guard: new PermissionsGuard(reflector), context };
  }

  const key = (permissions: string[], role: 'admin' | 'user' = 'user') => ({
    username: 'cosmos_u1',
    credentialId: 'cred_1',
    environment: 'prod',
    role,
    permissions,
    organizationId: null,
    plan: null,
    planSwapFeeBps: null,
  });

  function denial(guard: PermissionsGuard, context: ExecutionContext) {
    try {
      guard.canActivate(context);
    } catch (err) {
      return err as ApiError;
    }
    throw new Error('expected the guard to deny');
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('denies a key that lacks the required scope', () => {
    const { guard, context } = build(
      { [PERMISSIONS_KEY]: ['webhooks:write'] },
      key(['webhooks:read']),
    );

    const err = denial(guard, context);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(err.code).toBe(ApiErrorCode.InsufficientScope);
    // Naming the missing scope is what makes a 403 actionable.
    expect(err.message).toContain('webhooks:write');
  });

  it('allows a key that holds every required scope', () => {
    const { guard, context } = build(
      { [PERMISSIONS_KEY]: ['payments:read', 'payments:write'] },
      key(['payments:read', 'payments:write', 'swaps:read']),
    );

    expect(guard.canActivate(context)).toBe(true);
  });

  it('requires ALL of the required scopes, not any', () => {
    const { guard, context } = build(
      { [PERMISSIONS_KEY]: ['payments:read', 'payments:write'] },
      key(['payments:read']),
    );

    const err = denial(guard, context);
    expect(err.message).toContain('payments:write');
    expect(err.message).not.toContain('payments:read');
  });

  it('accepts any ONE of an any-of set', () => {
    const { guard, context } = build(
      { [ANY_PERMISSIONS_KEY]: ['liquidity:write', 'swaps:write'] },
      key(['swaps:write']),
    );

    expect(guard.canActivate(context)).toBe(true);
  });

  it('denies an any-of set when the key holds none of them', () => {
    const { guard, context } = build(
      { [ANY_PERMISSIONS_KEY]: ['liquidity:write', 'swaps:write'] },
      key(['payments:read']),
    );

    const err = denial(guard, context);
    expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(err.code).toBe(ApiErrorCode.InsufficientScope);
  });

  it('fails closed on a scoped route with no authenticated consumer', () => {
    // ApisixGuard normally rejects first; this is the defence in depth.
    const { guard, context } = build(
      { [PERMISSIONS_KEY]: ['payments:write'] },
      undefined,
    );

    const err = denial(guard, context);
    expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect(err.code).toBe(ApiErrorCode.NoAuthenticatedConsumer);
  });

  it('treats a key with no permissions array as holding none', () => {
    const { guard, context } = build(
      { [PERMISSIONS_KEY]: ['payments:write'] },
      { ...key([]), permissions: undefined },
    );

    expect(denial(guard, context).code).toBe(ApiErrorCode.InsufficientScope);
  });

  it('lets an admin key through without the scope', () => {
    const { guard, context } = build(
      { [PERMISSIONS_KEY]: ['payments:write'] },
      key([], 'admin'),
    );

    expect(guard.canActivate(context)).toBe(true);
  });

  it('bypasses ONLY for the exact admin role', () => {
    // The bypass is total, so it must not widen to any truthy role.
    for (const role of ['administrator', 'Admin', 'user', '', null]) {
      const { guard, context } = build(
        { [PERMISSIONS_KEY]: ['payments:write'] },
        {
          ...key([]),
          role,
        },
      );
      expect(denial(guard, context).code).toBe(ApiErrorCode.InsufficientScope);
    }
  });

  it('allows a route that declares no scope', () => {
    const { guard, context } = build({}, key([]));

    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows a @Public() route without a consumer', () => {
    const { guard, context } = build(
      { [IS_PUBLIC_KEY]: true, [PERMISSIONS_KEY]: ['payments:write'] },
      undefined,
    );

    expect(guard.canActivate(context)).toBe(true);
  });
});
