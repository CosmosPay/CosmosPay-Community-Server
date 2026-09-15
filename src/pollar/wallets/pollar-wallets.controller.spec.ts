import { Reflector } from '@nestjs/core';
import { RATE_LIMIT_KEY } from '@/common/decorators/rate-limit.decorator';
import {
  POLLAR_CONSUMER_QUOTA_RATE_LIMIT,
  POLLAR_TRUSTLINE_RATE_LIMIT,
  POLLAR_WALLET_DAILY_RATE_LIMIT,
} from '@/pollar/pollar.constants';
import { PollarWalletsController } from '@/pollar/wallets/pollar-wallets.controller';

const policiesOf = (handler: (...args: any[]) => unknown) =>
  new Reflector().get(RATE_LIMIT_KEY, handler);

const routes = PollarWalletsController.prototype;

describe('PollarWalletsController rate limits', () => {
  it('caps both trustline-adding routes from one shared bucket', () => {
    // Every asset locks reserve out of the funding wallet, and neither route
    // had a limit. The same policy object on both, not two equal ones: separate
    // buckets would double what a loop gets by alternating the routes.
    expect(policiesOf(routes.defaultTrustlines)).toContain(
      POLLAR_TRUSTLINE_RATE_LIMIT,
    );
    expect(policiesOf(routes.createTrustlines)).toContain(
      POLLAR_TRUSTLINE_RATE_LIMIT,
    );
  });

  it('counts every route that reaches Pollar against the per-consumer quota', () => {
    // One tenant must not be able to spend the request budget every tenant
    // shares; several of these had no limit at all.
    for (const handler of [
      routes.activate,
      routes.defaultTrustlines,
      routes.createTrustlines,
      routes.removeTrustline,
      routes.registerUser,
      routes.registerUserWithWallet,
      routes.verifyToken,
    ]) {
      expect(policiesOf(handler)).toContain(POLLAR_CONSUMER_QUOTA_RATE_LIMIT);
    }
  });

  it('counts users/with-wallet against the daily wallet ceiling', () => {
    expect(policiesOf(routes.registerUserWithWallet)).toContain(
      POLLAR_WALLET_DAILY_RATE_LIMIT,
    );
  });
});
