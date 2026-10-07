import { CONSOLE_MARKER_MAX_SKEW_S } from '@/admin/admin.constants';
import { signConsoleMarker, verifyConsoleMarker } from '@/admin/console-marker';

const SECRET = 'topsecret-topsecret-topsecret-topsecret';
const NOW = 1_790_000_000_000;

/**
 * The console marker is one contract across two repositories: the dev platform
 * mints it, this service verifies it. Neither toolchain can see the other, so
 * this vector is pinned on BOTH sides (the platform's `consoleMarker.test.ts`
 * holds the same literal). Change the label, the format or the MAC on one side
 * alone and the matching test fails instead of every admin screen going 403.
 */
const VECTOR =
  'v1.1790000000.d1b1d44235db836a61ef8b314a304580bb46f4f879fa4e9ad3ba2c242b26e125';

describe('console marker', () => {
  it('mints the pinned cross-repository vector', () => {
    expect(signConsoleMarker(SECRET, NOW)).toBe(VECTOR);
  });

  it('verifies a marker minted with the same secret', () => {
    expect(verifyConsoleMarker(VECTOR, SECRET, NOW)).toBe(true);
  });

  it('accepts clock skew up to the window, either way', () => {
    const skew = CONSOLE_MARKER_MAX_SKEW_S * 1000;
    expect(verifyConsoleMarker(VECTOR, SECRET, NOW + skew)).toBe(true);
    expect(verifyConsoleMarker(VECTOR, SECRET, NOW - skew)).toBe(true);
  });

  it('refuses a marker outside the window — a logged one is not a standing key', () => {
    const skew = (CONSOLE_MARKER_MAX_SKEW_S + 1) * 1000;
    expect(verifyConsoleMarker(VECTOR, SECRET, NOW + skew)).toBe(false);
    expect(verifyConsoleMarker(VECTOR, SECRET, NOW - skew)).toBe(false);
  });

  it('refuses a marker minted with another secret', () => {
    const forged = signConsoleMarker('not-the-gateway-secret-at-all', NOW);
    expect(verifyConsoleMarker(forged, SECRET, NOW)).toBe(false);
  });

  it('refuses a MAC moved onto another timestamp', () => {
    const mac = VECTOR.split('.')[2];
    expect(verifyConsoleMarker(`v1.1790000001.${mac}`, SECRET, NOW)).toBe(
      false,
    );
  });

  it('fails closed when the service has no gateway secret', () => {
    expect(verifyConsoleMarker(signConsoleMarker('', NOW), '', NOW)).toBe(
      false,
    );
  });

  it.each([
    ['the old bare marker', '1'],
    ['a truthy word', 'true'],
    ['an empty value', ''],
    ['no value', undefined],
    ['another version', VECTOR.replace(/^v1\./, 'v2.')],
    ['a missing part', 'v1.1790000000'],
    ['an extra part', `${VECTOR}.x`],
    ['a non-numeric timestamp', VECTOR.replace('1790000000', 'abc')],
    ['an uppercase MAC', VECTOR.toUpperCase().replace(/^V1/, 'v1')],
    ['a short MAC', VECTOR.slice(0, -2)],
  ])('refuses %s', (_label, raw) => {
    expect(verifyConsoleMarker(raw, SECRET, NOW)).toBe(false);
  });
});
