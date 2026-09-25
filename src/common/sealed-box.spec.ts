import { openJson, sealJson } from '@/common/sealed-box';

describe('sealed-box', () => {
  const secret = 'a-server-secret-long-enough-to-be-real';
  const purpose = 'wallet-auth-session';
  const value = { email: 'a@b.com', exp: 1 };

  it('round-trips a value', () => {
    expect(openJson(sealJson(value, secret, purpose), secret, purpose)).toEqual(
      value,
    );
  });

  it('refuses a box sealed for another purpose', () => {
    const box = sealJson(value, secret, 'some-other-purpose');
    expect(openJson(box, secret, purpose)).toBeNull();
  });

  it('refuses a box sealed under another secret', () => {
    const box = sealJson(value, 'a-different-server-secret-entirely', purpose);
    expect(openJson(box, secret, purpose)).toBeNull();
  });

  it('refuses an edited ciphertext rather than decrypting it to something else', () => {
    const [v, iv, tag, body] = sealJson(value, secret, purpose).split('.');
    const flipped = Buffer.from(body, 'base64url');
    flipped[0] ^= 0xff;
    const edited = [v, iv, tag, flipped.toString('base64url')].join('.');
    expect(openJson(edited, secret, purpose)).toBeNull();
  });

  it('refuses a truncated authentication tag instead of accepting a weaker check', () => {
    const [v, iv, tag, body] = sealJson(value, secret, purpose).split('.');
    const short = Buffer.from(tag, 'base64url')
      .subarray(0, 8)
      .toString('base64url');
    expect(
      openJson([v, iv, short, body].join('.'), secret, purpose),
    ).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['not a box', 'hello'],
    ['wrong version', 'v2.a.b.c'],
    ['too many segments', `${sealJson(value, secret, purpose)}.extra`],
  ])('returns null for %s rather than throwing', (_label, input) => {
    expect(openJson(input, secret, purpose)).toBeNull();
  });

  it('requires a non-empty secret', () => {
    expect(() => sealJson(value, '', purpose)).toThrow(/non-empty secret/);
  });
});
