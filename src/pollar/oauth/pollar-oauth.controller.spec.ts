import { Reflector } from '@nestjs/core';
import { RATE_LIMIT_KEY } from '@/common/decorators/rate-limit.decorator';
import { PollarOauthController } from '@/pollar/oauth/pollar-oauth.controller';
import {
  POLLAR_AUTHORIZE_RATE_LIMIT,
  POLLAR_CONSUMER_QUOTA_RATE_LIMIT,
  POLLAR_POLL_RATE_LIMIT,
  POLLAR_SESSION_RATE_LIMIT,
  POLLAR_TOKEN_RATE_LIMIT,
  POLLAR_WALLET_DAILY_RATE_LIMIT,
} from '@/pollar/pollar.constants';

const policiesOf = (handler: (...args: any[]) => unknown) =>
  new Reflector().get(RATE_LIMIT_KEY, handler);

const bridge = PollarOauthController.prototype;

describe('PollarOauthController rate limits', () => {
  it('caps logins per address, and per consumer per day', () => {
    // A consent on a login link can create and fund a wallet even when the
    // session is then refused, so opening a login is where wallets are counted —
    // and per consumer, because rotating addresses would multiply the other one.
    expect(policiesOf(bridge.authorize)).toEqual([
      POLLAR_AUTHORIZE_RATE_LIMIT,
      POLLAR_WALLET_DAILY_RATE_LIMIT,
      POLLAR_CONSUMER_QUOTA_RATE_LIMIT,
    ]);
  });

  it('limits every route that reaches Pollar, the poll included', () => {
    // Each of these spends the request budget every tenant shares; they had no
    // limit at all.
    expect(policiesOf(bridge.status)).toEqual([POLLAR_POLL_RATE_LIMIT]);
    expect(policiesOf(bridge.exchange)).toEqual([
      POLLAR_TOKEN_RATE_LIMIT,
      POLLAR_CONSUMER_QUOTA_RATE_LIMIT,
    ]);
    for (const handler of [bridge.refresh, bridge.logout]) {
      expect(policiesOf(handler)).toEqual([
        POLLAR_SESSION_RATE_LIMIT,
        POLLAR_CONSUMER_QUOTA_RATE_LIMIT,
      ]);
    }
  });
});
