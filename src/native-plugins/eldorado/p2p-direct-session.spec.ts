import { sealJson } from '@/common/sealed-box';
import { P2P_DIRECT_SESSION_MAX_MS } from '@/native-plugins/eldorado/eldorado.constants';
import {
  openPayerSession,
  sealPayerSession,
  sessionExpiry,
  type PayerSessionClaims,
} from '@/native-plugins/eldorado/p2p-direct-session';

const SECRET = Buffer.alloc(32, 1).toString('base64');
const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const CLAIMS: PayerSessionClaims = {
  t: 'eyJhbGciOiJSUzI1NiJ9.payer-token.sig',
  n: 'public',
  r: 'cmh4x2k9a0001l70g8v5q3z2w',
  e: NOW + 60_000,
};
const EXPECTED = { requestId: CLAIMS.r, network: CLAIMS.n };

describe('the payer session', () => {
  it('opens for its request and network before it expires, and hides the token', () => {
    const sealed = sealPayerSession(CLAIMS, SECRET);

    expect(sealed).not.toContain('payer-token');
    expect(sealed).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(openPayerSession(sealed, SECRET, EXPECTED, NOW)).toEqual(CLAIMS);
  });

  it('refuses a session issued for another request or network', () => {
    const sealed = sealPayerSession(CLAIMS, SECRET);

    expect(
      openPayerSession(
        sealed,
        SECRET,
        { ...EXPECTED, requestId: 'cotherrequest00000000000' },
        NOW,
      ),
    ).toBeNull();
    expect(
      openPayerSession(
        sealed,
        SECRET,
        { ...EXPECTED, network: 'testnet' },
        NOW,
      ),
    ).toBeNull();
  });

  it('refuses a session at or past its expiry', () => {
    const sealed = sealPayerSession(CLAIMS, SECRET);

    expect(openPayerSession(sealed, SECRET, EXPECTED, CLAIMS.e)).toBeNull();
    expect(openPayerSession(sealed, SECRET, EXPECTED, CLAIMS.e + 1)).toBeNull();
  });

  it('refuses a tampered, truncated, foreign or missing session', () => {
    const sealed = sealPayerSession(CLAIMS, SECRET);
    const [version, iv, tag, body] = sealed.split('.');
    const flipped = `${body.slice(0, -2)}${body.endsWith('A') ? 'B' : 'A'}${body.slice(-1)}`;

    for (const bad of [
      [version, iv, tag, flipped].join('.'),
      sealed.slice(0, -4),
      `${sealed}.extra`,
      'not-a-session',
      '',
      undefined,
      'x'.repeat(10_000),
    ]) {
      expect(openPayerSession(bad, SECRET, EXPECTED, NOW)).toBeNull();
    }
    // Another deployment's secret, and an empty one.
    expect(
      openPayerSession(
        sealed,
        Buffer.alloc(32, 2).toString('base64'),
        EXPECTED,
        NOW,
      ),
    ).toBeNull();
    expect(openPayerSession(sealed, '', EXPECTED, NOW)).toBeNull();
  });

  it('refuses a box sealed for another purpose, or claims of the wrong shape', () => {
    expect(
      openPayerSession(
        sealJson(CLAIMS, SECRET, 'wallet-sign-in v1'),
        SECRET,
        EXPECTED,
        NOW,
      ),
    ).toBeNull();
    for (const claims of [
      { ...CLAIMS, t: '' },
      { ...CLAIMS, t: 42 },
      { ...CLAIMS, e: 'tomorrow' },
      { n: CLAIMS.n, r: CLAIMS.r, e: CLAIMS.e },
    ]) {
      expect(
        openPayerSession(
          sealPayerSession(claims as PayerSessionClaims, SECRET),
          SECRET,
          EXPECTED,
          NOW,
        ),
      ).toBeNull();
    }
  });

  it('lives as long as the marketplace token, never past the cap', () => {
    expect(sessionExpiry(NOW, NOW + 60_000)).toBe(NOW + 60_000);
    expect(sessionExpiry(NOW, NOW + 30 * 24 * 3_600_000)).toBe(
      NOW + P2P_DIRECT_SESSION_MAX_MS,
    );
    expect(sessionExpiry(NOW, null)).toBe(NOW + P2P_DIRECT_SESSION_MAX_MS);
  });
});
