import { resolveTosCooldownMs } from '@/kyc/receivers/tos-cooldown-header';

describe('resolveTosCooldownMs — parsing only', () => {
  it('returns undefined without the internal marker', () => {
    expect(resolveTosCooldownMs(undefined, '0')).toBeUndefined();
    expect(resolveTosCooldownMs('0', '0')).toBeUndefined();
  });

  it('parses a non-negative value when the marker is present', () => {
    expect(resolveTosCooldownMs('1', '0')).toBe(0);
    expect(resolveTosCooldownMs(['1'], ['60000'])).toBe(60000);
  });

  it('rejects a missing or nonsensical value', () => {
    expect(resolveTosCooldownMs('1', '')).toBeUndefined();
    expect(resolveTosCooldownMs('1', 'soon')).toBeUndefined();
    expect(resolveTosCooldownMs('1', '-1')).toBeUndefined();
  });
});
