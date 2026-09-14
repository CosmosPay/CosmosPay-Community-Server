import { Reflector } from '@nestjs/core';
import { RATE_LIMIT_KEY } from '@/common/decorators/rate-limit.decorator';
import { POLLAR_TRUSTLINE_RATE_LIMIT } from '@/pollar/pollar.constants';
import { PollarWalletsController } from '@/pollar/wallets/pollar-wallets.controller';

const policyOf = (handler: (...args: any[]) => unknown) =>
  new Reflector().get(RATE_LIMIT_KEY, handler);

describe('PollarWalletsController rate limits', () => {
  it('caps both trustline-adding routes from one shared bucket', () => {
    // Every asset locks reserve out of the funding wallet, and neither route
    // had a limit. The same policy object on both, not two equal ones: separate
    // buckets would double what a loop gets by alternating the routes.
    expect(policyOf(PollarWalletsController.prototype.defaultTrustlines)).toBe(
      POLLAR_TRUSTLINE_RATE_LIMIT,
    );
    expect(policyOf(PollarWalletsController.prototype.createTrustlines)).toBe(
      POLLAR_TRUSTLINE_RATE_LIMIT,
    );
  });
});
