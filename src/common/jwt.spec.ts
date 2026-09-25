import { issueJwt, readJwt } from '@/common/jwt';

const SECRET = 'a-jwt-secret-that-is-long-enough-000000';
const NOW = 1_800_000_000;

const claims = (over: Record<string, unknown> = {}) => ({
  sub: 'GABC',
  iss: 'https://recovery-a.example.com/v1/sep10/auth',
  aud: 'recovery-a.example.com',
  iat: NOW,
  exp: NOW + 60,
  ...over,
});

describe('jwt', () => {
  it('round-trips under the same secret, purpose and audience', () => {
    const token = issueJwt(claims(), SECRET, 'sep10:a');
    expect(
      readJwt(token, SECRET, 'sep10:a', 'recovery-a.example.com', NOW),
    ).toMatchObject({ sub: 'GABC' });
  });

  /* The separation the recovery routes rest on: an identity token must never
     read as "holds the account's key", and the sibling server's never as ours. */
  it.each([
    [
      'another purpose',
      'recovery-identity:a',
      'recovery-a.example.com',
      SECRET,
    ],
    ['the sibling role', 'sep10:b', 'recovery-a.example.com', SECRET],
    ['another audience', 'sep10:a', 'recovery-b.example.com', SECRET],
    [
      'another secret',
      'sep10:a',
      'recovery-a.example.com',
      'some-other-secret-long-enough-0000000',
    ],
  ])('refuses a token read with %s', (_, purpose, audience, secret) => {
    const token = issueJwt(claims(), SECRET, 'sep10:a');
    expect(readJwt(token, secret, purpose, audience, NOW)).toBeNull();
  });

  it('refuses an expired token', () => {
    const token = issueJwt(claims({ exp: NOW }), SECRET, 'sep10:a');
    expect(
      readJwt(token, SECRET, 'sep10:a', 'recovery-a.example.com', NOW),
    ).toBeNull();
  });

  it('refuses any header but its own, alg none included', () => {
    const token = issueJwt(claims(), SECRET, 'sep10:a');
    const [, payload, sig] = token.split('.');
    const none = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url');
    expect(
      readJwt(
        `${none}.${payload}.${sig}`,
        SECRET,
        'sep10:a',
        'recovery-a.example.com',
        NOW,
      ),
    ).toBeNull();
    expect(
      readJwt(
        `${none}.${payload}.`,
        SECRET,
        'sep10:a',
        'recovery-a.example.com',
        NOW,
      ),
    ).toBeNull();
  });

  it('refuses an edited payload', () => {
    const token = issueJwt(claims(), SECRET, 'sep10:a');
    const [h, , s] = token.split('.');
    const edited = Buffer.from(
      JSON.stringify({ ...claims(), sub: 'GXYZ', jti: 'x' }),
    ).toString('base64url');
    expect(
      readJwt(
        `${h}.${edited}.${s}`,
        SECRET,
        'sep10:a',
        'recovery-a.example.com',
        NOW,
      ),
    ).toBeNull();
  });

  it('gives every token its own jti', () => {
    const a = readJwt(
      issueJwt(claims(), SECRET, 'p'),
      SECRET,
      'p',
      'recovery-a.example.com',
      NOW,
    );
    const b = readJwt(
      issueJwt(claims(), SECRET, 'p'),
      SECRET,
      'p',
      'recovery-a.example.com',
      NOW,
    );
    expect(a?.jti).toBeTruthy();
    expect(a?.jti).not.toBe(b?.jti);
  });
});
