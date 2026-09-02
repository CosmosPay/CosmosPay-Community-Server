import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { AdminGuard } from '@/common/guards/admin.guard';
import { ADMIN_ROLE_KEY } from '@/common/decorators/require-admin-role.decorator';

/**
 * Red suite for issue #34: AdminGuard must verify a real Bearer credential
 * and enforce read vs write. The legacy `X-Cosmos-Admin: 1` marker must NOT grant access.
 */
/** Asserts the guard denied with a specific status *and* error code. */
function expectDenied(
  run: () => unknown,
  status: HttpStatus,
  code: ApiErrorCode,
): void {
  let thrown: unknown;
  try {
    run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ApiError);
  expect((thrown as ApiError).getStatus()).toBe(status);
  expect((thrown as ApiError).code).toBe(code);
}

describe('AdminGuard (issue #34)', () => {
  const readSecret = 'read-secret-000000';
  const writeSecret = 'write-secret-00000';

  const config = {
    get: () => ({
      credentials: [
        { id: 'viewer', secret: readSecret, role: 'read' },
        { id: 'owner', secret: writeSecret, role: 'write' },
      ],
    }),
  } as any;

  function ctx(
    headers: Record<string, string>,
    requiredRole?: 'read' | 'write',
  ) {
    const request: any = { headers, adminPrincipal: undefined };
    const reflector = {
      getAllAndOverride: (key: string) =>
        key === ADMIN_ROLE_KEY ? requiredRole : undefined,
    } as unknown as Reflector;
    const guard = new AdminGuard(config, reflector);
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    return { guard, request, context };
  }

  it('rejects the legacy plaintext X-Cosmos-Admin: 1 marker with 401', () => {
    const { guard, context } = ctx({ 'x-cosmos-admin': '1' });
    expectDenied(
      () => guard.canActivate(context),
      HttpStatus.UNAUTHORIZED,
      ApiErrorCode.AdminCredentialsRequired,
    );
  });

  it('returns 401 when Authorization Bearer is missing', () => {
    const { guard, context } = ctx({});
    expectDenied(
      () => guard.canActivate(context),
      HttpStatus.UNAUTHORIZED,
      ApiErrorCode.AdminCredentialsRequired,
    );
  });

  it('returns 401 when the Bearer secret is wrong', () => {
    const { guard, context } = ctx({
      authorization: 'Bearer totally-wrong-secret!!',
    });
    expectDenied(
      () => guard.canActivate(context),
      HttpStatus.UNAUTHORIZED,
      ApiErrorCode.AdminCredentialsRequired,
    );
  });

  it('allows a read credential on a read endpoint and attaches the principal', () => {
    const { guard, context, request } = ctx(
      { authorization: `Bearer ${readSecret}` },
      'read',
    );
    expect(guard.canActivate(context)).toBe(true);
    expect(request.adminPrincipal).toEqual({ id: 'viewer', role: 'read' });
  });

  it('returns 403 when a read credential hits a write endpoint', () => {
    const { guard, context } = ctx(
      { authorization: `Bearer ${readSecret}` },
      'write',
    );
    expectDenied(
      () => guard.canActivate(context),
      HttpStatus.FORBIDDEN,
      ApiErrorCode.AdminRoleRequired,
    );
  });

  it('allows a write credential on a write endpoint', () => {
    const { guard, context, request } = ctx(
      { authorization: `Bearer ${writeSecret}` },
      'write',
    );
    expect(guard.canActivate(context)).toBe(true);
    expect(request.adminPrincipal).toEqual({ id: 'owner', role: 'write' });
  });
});
