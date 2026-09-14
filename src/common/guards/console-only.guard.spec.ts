import { ExecutionContext } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { ConsoleOnlyGuard } from '@/common/guards/console-only.guard';

function ctx(headers: Record<string, string | string[]>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
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

describe('ConsoleOnlyGuard', () => {
  const guard = new ConsoleOnlyGuard();

  it('admits a call carrying the internal marker', () => {
    expect(guard.canActivate(ctx({ 'x-cosmos-internal': '1' }))).toBe(true);
    expect(guard.canActivate(ctx({ 'x-cosmos-internal': 'true' }))).toBe(true);
  });

  it('refuses an API-key caller, whatever its role', () => {
    // An `admin` key clears every scope check, and that must not be a way to
    // receive a recovery token: scopes describe a key, not who delivers the mail.
    expect(
      codeOf(() =>
        guard.canActivate(
          ctx({
            'x-consumer-username': 'cosmos_u1',
            'x-consumer-role': 'admin',
          }),
        ),
      ),
    ).toBe(ApiErrorCode.AdminConsoleOnly);
  });

  it('takes an explicit negative at its word', () => {
    for (const value of ['0', 'false', 'no', 'off', '', '   ']) {
      expect(
        codeOf(() => guard.canActivate(ctx({ 'x-cosmos-internal': value }))),
      ).toBe(ApiErrorCode.AdminConsoleOnly);
    }
  });

  it('reads only the first value of a repeated header', () => {
    expect(guard.canActivate(ctx({ 'x-cosmos-internal': ['1', '0'] }))).toBe(
      true,
    );
    expect(
      codeOf(() => guard.canActivate(ctx({ 'x-cosmos-internal': ['0', '1'] }))),
    ).toBe(ApiErrorCode.AdminConsoleOnly);
  });
});
