import {
  CUSTOM_ROUTE_ARGS_METADATA,
  HEADERS_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
  VERSION_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '@/common/decorators/public.decorator';
import {
  RATE_LIMIT_KEY,
  type RateLimitPolicy,
} from '@/common/decorators/rate-limit.decorator';
import { PERMISSIONS_KEY } from '@/common/decorators/require-permissions.decorator';
import { PAYMENT_LINK_READ_RATE_LIMIT } from '@/payment-intents/payment-intents.constants';
import { PaymentLinksController } from '@/payment-intents/payment-links.controller';

const reflector = new Reflector();
const handler = PaymentLinksController.prototype.findOne;

describe('PaymentLinksController', () => {
  it('serves /v1/payment-links/:id', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PaymentLinksController)).toBe(
      'payment-links',
    );
    expect(Reflect.getMetadata(VERSION_METADATA, PaymentLinksController)).toBe(
      '1',
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id');
  });

  it('is @Public(): a checkout page holds no API key and no gateway secret', () => {
    expect(reflector.get(IS_PUBLIC_KEY, handler)).toBe(true);
    // A scope means nothing without a consumer, and there is none here.
    expect(reflector.get(PERMISSIONS_KEY, handler)).toBeUndefined();
  });

  it('reads nothing but the id — in particular no consumer', () => {
    // `@CurrentConsumer()` is a custom parameter decorator; a @Public() route
    // has no consumer, and one read here would be whatever the client typed.
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      PaymentLinksController,
      'findOne',
    ) as Record<string, { data?: unknown }>;
    const keys = Object.keys(args);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(CUSTOM_ROUTE_ARGS_METADATA);
    expect(Object.values(args)[0].data).toBe('id');
  });

  it('is budgeted per client address, never per consumer', () => {
    const policies = reflector.get<RateLimitPolicy[]>(RATE_LIMIT_KEY, handler);
    expect(policies).toEqual([PAYMENT_LINK_READ_RATE_LIMIT]);
    // Every anonymous caller is the same `anonymous` consumer on a @Public()
    // route, so a consumer budget would be one bucket for every payer.
    expect(policies.every((p) => p.per !== 'consumer')).toBe(true);
  });

  it('tolerates one checkout tab polling every 5 s, with room to reload', () => {
    const { limit, windowMs } = PAYMENT_LINK_READ_RATE_LIMIT;
    const pollsPerWindow = windowMs / 5_000;
    expect(limit).toBeGreaterThanOrEqual(pollsPerWindow * 2);
  });

  it('is never cached: the status changes while the page is open', () => {
    expect(reflector.get(HEADERS_METADATA, handler)).toEqual([
      { name: 'Cache-Control', value: 'no-store' },
    ]);
  });
});
