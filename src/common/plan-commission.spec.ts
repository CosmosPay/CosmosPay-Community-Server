import { HttpStatus } from '@nestjs/common';
import { ApiError, ApiErrorCode } from './errors/api-error';
import { resolvePlanCommissionBps } from './plan-commission';
import type { GatewayConsumer } from './interfaces/gateway-consumer.interface';

/**
 * This rule decides what every organization is charged on a swap and on a
 * liquidity-pool withdrawal. It existed as two private copies that had already
 * drifted — the swaps copy failed closed when the gateway stopped forwarding
 * the plan rate, the pools copy silently repriced everyone at the platform
 * default — which is exactly why it now has one home, and a test of its own
 * rather than only tests of its callers.
 */
describe('resolvePlanCommissionBps', () => {
  const consumer = (planSwapFeeBps: number | null): GatewayConsumer => ({
    username: 'cosmos_u1',
    credentialId: 'cred_1',
    environment: 'prod',
    role: 'user',
    permissions: [],
    organizationId: 'org_1',
    plan: 'pro',
    planSwapFeeBps,
  });

  const config = (nodeEnv: string, feeBps = 50, feeWallet = 'GFEE') =>
    ({
      get: (key: string) =>
        key === 'nodeEnv'
          ? nodeEnv
          : key === 'apisix'
            ? { swapFeeBpsHeader: 'x-plan-swap-fee-bps' }
            : { swap: { feeBps, feeWallet } },
    }) as never;

  it('uses the forwarded plan rate, whatever the configured default is', () => {
    expect(
      resolvePlanCommissionBps(config('production', 999), consumer(25)),
    ).toBe(25);
    expect(
      resolvePlanCommissionBps(config('development', 999), consumer(25)),
    ).toBe(25);
  });

  it('honours a forwarded zero — a free plan is not a missing header', () => {
    // `0` is falsy; only `null` means "the gateway sent nothing".
    expect(resolvePlanCommissionBps(config('production'), consumer(0))).toBe(0);
  });

  it('fails closed in production when the gateway forwarded no rate', () => {
    let thrown: unknown;
    try {
      resolvePlanCommissionBps(config('production', 999), consumer(null));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).getStatus()).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect((thrown as ApiError).code).toBe(ApiErrorCode.Misconfigured);
    // The operator must be told which header the gateway stopped sending.
    expect((thrown as ApiError).message).toMatch(/x-plan-swap-fee-bps/i);
  });

  it('never silently reprices at the platform default in production', () => {
    // The dangerous outcome is not an error — it is a successful, wrong price.
    // This is precisely what the liquidity-pools copy used to do.
    expect(() =>
      resolvePlanCommissionBps(config('production', 999), consumer(null)),
    ).toThrow(ApiError);
  });

  it('falls back to the configured default outside production', () => {
    // So the service still runs locally with no gateway in front of it.
    expect(
      resolvePlanCommissionBps(config('development', 50), consumer(null)),
    ).toBe(50);
    expect(resolvePlanCommissionBps(config('test', 50), consumer(null))).toBe(
      50,
    );
  });

  it('charges nothing outside production when no fee wallet is configured', () => {
    // A fee with nowhere to send it must not be quoted.
    expect(
      resolvePlanCommissionBps(config('development', 50, ''), consumer(null)),
    ).toBe(0);
  });
});
