import { HttpStatus } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { commissionWithRecipient } from '@/common/plan-commission';

/**
 * A commission with nowhere to be paid is a misconfiguration, not a free swap. The only way
 * past that is SWAP_COMMISSION_DEV_WAIVER, which the service refuses to boot with in
 * production (env.validation.spec.ts pins that half).
 */
describe('commissionWithRecipient', () => {
  const config = (waiver: boolean) =>
    ({
      get: (key: string) =>
        key === 'swapCommissionDevWaiver' ? waiver : undefined,
    }) as never;

  it('charges the plan commission when it has a recipient', () => {
    expect(
      commissionWithRecipient(
        config(false),
        50,
        'fees.near',
        'NEAR_INTENTS_FEE_RECIPIENT',
      ),
    ).toBe(50);
    expect(
      commissionWithRecipient(
        config(true),
        50,
        'fees.near',
        'NEAR_INTENTS_FEE_RECIPIENT',
      ),
    ).toBe(50);
  });

  it('needs no recipient for a plan without a commission', () => {
    expect(
      commissionWithRecipient(config(false), 0, '', 'SOLANA_SWAP_FEE_WALLET'),
    ).toBe(0);
  });

  it('refuses with misconfigured (503) when the recipient is missing', () => {
    let thrown: unknown;
    try {
      commissionWithRecipient(config(false), 50, '', 'MONAD_SWAP_FEE_WALLET');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    const error = thrown as ApiError;
    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(error.code).toBe(ApiErrorCode.Misconfigured);
    expect(error.message).toContain('MONAD_SWAP_FEE_WALLET');
  });

  it('waives it, locally, only when SWAP_COMMISSION_DEV_WAIVER is on', () => {
    expect(
      commissionWithRecipient(
        config(true),
        50,
        '',
        'NEAR_INTENTS_FEE_RECIPIENT',
      ),
    ).toBe(0);
  });
});
