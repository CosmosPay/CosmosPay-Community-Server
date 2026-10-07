import { resolveTosCooldownMs } from '@/native-plugins/blindpay/kyc/receivers/tos-cooldown-header';

describe('resolveTosCooldownMs — parsing only', () => {
  it('returns undefined for a call that is not verified-internal', () => {
    expect(resolveTosCooldownMs(false, '0')).toBeUndefined();
    expect(resolveTosCooldownMs(false, ['60000'])).toBeUndefined();
  });

  it('parses a non-negative value for a verified-internal call', () => {
    expect(resolveTosCooldownMs(true, '0')).toBe(0);
    expect(resolveTosCooldownMs(true, ['60000'])).toBe(60000);
  });

  it('rejects a missing or nonsensical value', () => {
    expect(resolveTosCooldownMs(true, undefined)).toBeUndefined();
    expect(resolveTosCooldownMs(true, '')).toBeUndefined();
    expect(resolveTosCooldownMs(true, 'soon')).toBeUndefined();
    expect(resolveTosCooldownMs(true, '-1')).toBeUndefined();
  });
});
