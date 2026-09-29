import { quoteExpiresAt } from '@/native-plugins/blindpay/blindpay.util';

describe('quoteExpiresAt', () => {
  it('reads a Unix-seconds expiry', () => {
    expect(quoteExpiresAt(1_900_000_000)?.toISOString()).toBe(
      new Date(1_900_000_000_000).toISOString(),
    );
  });

  it('reads a milliseconds expiry as is', () => {
    expect(quoteExpiresAt(1_900_000_000_000)?.getTime()).toBe(
      1_900_000_000_000,
    );
  });

  it.each([undefined, null, '1900000000', 0, -5, Number.NaN, Infinity])(
    'has no expiry for %p, so the quote is not refused as expired',
    (value) => {
      expect(quoteExpiresAt(value)).toBeNull();
    },
  );
});
