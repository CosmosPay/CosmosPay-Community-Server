import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { AdminGuard } from '@/common/guards/admin.guard';

/**
 * AdminGuard admits the platform console and nothing else. There is no admin
 * secret to present any more: `ApisixGuard` has already verified the gateway
 * secret, and the internal marker — which APISIX strips from everything it
 * proxies — is what separates a console call from an API-key call.
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

describe('AdminGuard', () => {
  function ctx(
    headers: Record<string, string>,
    consumerUsername = 'cosmos_u1',
  ) {
    const request: any = {
      headers,
      gatewayConsumer: consumerUsername
        ? { username: consumerUsername, permissions: [] }
        : undefined,
      adminPrincipal: undefined,
    };
    const guard = new AdminGuard();
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    return { guard, request, context };
  }

  it('returns 403 for an API-key call (no internal marker)', () => {
    const { guard, context } = ctx({});
    expectDenied(
      () => guard.canActivate(context),
      HttpStatus.FORBIDDEN,
      ApiErrorCode.AdminConsoleOnly,
    );
  });

  it('returns 403 for the legacy plaintext X-Cosmos-Admin: 1 marker', () => {
    const { guard, context } = ctx({ 'x-cosmos-admin': '1' });
    expectDenied(
      () => guard.canActivate(context),
      HttpStatus.FORBIDDEN,
      ApiErrorCode.AdminConsoleOnly,
    );
  });

  it('returns 403 when a Bearer token is presented instead of a console call', () => {
    // The old credential is gone; presenting one must not be a way in.
    const { guard, context } = ctx({
      authorization: 'Bearer write-secret-00000',
    });
    expectDenied(
      () => guard.canActivate(context),
      HttpStatus.FORBIDDEN,
      ApiErrorCode.AdminConsoleOnly,
    );
  });

  it('returns 403 when the marker is explicitly negative', () => {
    const { guard, context } = ctx({ 'x-cosmos-internal': '0' });
    expectDenied(
      () => guard.canActivate(context),
      HttpStatus.FORBIDDEN,
      ApiErrorCode.AdminConsoleOnly,
    );
  });

  it('admits a console call and attaches the principal for the audit trail', () => {
    const { guard, context, request } = ctx({
      'x-cosmos-internal': '1',
      'x-cosmos-admin-role': 'owner',
    });
    expect(guard.canActivate(context)).toBe(true);
    expect(request.adminPrincipal).toEqual({ id: 'cosmos_u1', role: 'owner' });
  });

  it('admits a console call that asserts no role, labelling the audit row', () => {
    const { guard, context, request } = ctx(
      { 'x-cosmos-internal': '1' },
      'cosmos_u9',
    );
    expect(guard.canActivate(context)).toBe(true);
    expect(request.adminPrincipal).toEqual({
      id: 'cosmos_u9',
      role: 'internal',
    });
  });

  it('does not gate on the asserted role — the console already decided', () => {
    const { guard, context, request } = ctx({
      'x-cosmos-internal': '1',
      'x-cosmos-admin-role': 'support',
    });
    expect(guard.canActivate(context)).toBe(true);
    expect(request.adminPrincipal?.role).toBe('support');
  });
});
