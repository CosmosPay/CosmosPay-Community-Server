import {
  assertP2pDirectConfigConsistent,
  parseP2pDirectSessionSecret,
} from '@/config/p2p-direct-env';

describe('the P2P direct session secret', () => {
  it('reads 32 or more bytes in hex, base64 or base64url', () => {
    const bytes = Buffer.alloc(32, 9);
    expect(parseP2pDirectSessionSecret(bytes.toString('hex'))).toEqual(bytes);
    expect(parseP2pDirectSessionSecret(bytes.toString('base64'))).toEqual(
      bytes,
    );
    expect(parseP2pDirectSessionSecret(bytes.toString('base64url'))).toEqual(
      bytes,
    );
    const longer = Buffer.alloc(48, 3);
    expect(parseP2pDirectSessionSecret(longer.toString('base64'))).toEqual(
      longer,
    );
  });

  it('refuses fewer than 32 bytes, and anything that is not hex or base64', () => {
    expect(
      parseP2pDirectSessionSecret(Buffer.alloc(31).toString('hex')),
    ).toBeNull();
    expect(
      parseP2pDirectSessionSecret(Buffer.alloc(16).toString('base64')),
    ).toBeNull();
    expect(parseP2pDirectSessionSecret('not a secret at all, has spaces')).toBe(
      null,
    );
    expect(parseP2pDirectSessionSecret('')).toBeNull();
  });

  it('lets a deployment without it boot, and refuses one that is malformed', () => {
    expect(() => assertP2pDirectConfigConsistent({})).not.toThrow();
    expect(() =>
      assertP2pDirectConfigConsistent({ P2P_DIRECT_SESSION_SECRET: '' }),
    ).not.toThrow();
    expect(() =>
      assertP2pDirectConfigConsistent({
        P2P_DIRECT_SESSION_SECRET: Buffer.alloc(32, 1).toString('base64'),
      }),
    ).not.toThrow();
    expect(() =>
      assertP2pDirectConfigConsistent({ P2P_DIRECT_SESSION_SECRET: 'short' }),
    ).toThrow(/at least 32 bytes/);
    expect(() =>
      assertP2pDirectConfigConsistent({
        P2P_DIRECT_SESSION_SECRET: 'replace-me-with-a-real-secret-of-sorts-xx',
      }),
    ).toThrow(/placeholder/);
  });
});
