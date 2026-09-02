import {
  assertPollarRedirectAllowed,
  buildWalletRedirect,
  parsePollarRedirectWhitelist,
} from '@/pollar/pollar-redirect-uri';

const CONSUMER = 'cosmos_acme';

function allow(...entries: string[]) {
  return { [CONSUMER]: entries };
}

function rejects(redirectUri: string, whitelist: Record<string, string[]>) {
  return () => assertPollarRedirectAllowed(CONSUMER, redirectUri, whitelist);
}

describe('parsePollarRedirectWhitelist', () => {
  it('parses a consumer -> entries map', () => {
    expect(
      parsePollarRedirectWhitelist(
        '{"cosmos_acme":["cosmospay://auth","http://127.0.0.1"]}',
      ),
    ).toEqual({ cosmos_acme: ['cosmospay://auth', 'http://127.0.0.1'] });
  });

  it('treats malformed input as empty so every consumer fails closed', () => {
    expect(parsePollarRedirectWhitelist('not json')).toEqual({});
    expect(parsePollarRedirectWhitelist('["cosmos_acme"]')).toEqual({});
    expect(parsePollarRedirectWhitelist(undefined)).toEqual({});
  });

  it('drops non-string entries rather than stringifying them', () => {
    expect(
      parsePollarRedirectWhitelist('{"cosmos_acme":["ok://x",5,null,""]}'),
    ).toEqual({ cosmos_acme: ['ok://x'] });
  });
});

describe('assertPollarRedirectAllowed', () => {
  it('accepts a loopback listener on any port and path', () => {
    const whitelist = allow('http://127.0.0.1');
    expect(
      assertPollarRedirectAllowed(
        CONSUMER,
        'http://127.0.0.1:53219/callback',
        whitelist,
      ),
    ).toBe('http://127.0.0.1:53219/callback');
  });

  it('does not let a loopback entry cover a different loopback host', () => {
    // `localhost` can resolve somewhere else entirely on a poisoned resolver,
    // so registering 127.0.0.1 is not registering localhost.
    expect(
      rejects('http://localhost:1234/cb', allow('http://127.0.0.1')),
    ).toThrow(/not allowed/);
  });

  it('refuses plain http that is not loopback', () => {
    expect(
      rejects('http://app.acme.com/cb', allow('http://app.acme.com')),
    ).toThrow(/https, a loopback address, or a private-use scheme/);
  });

  it('accepts a deeper path under a private-use scheme entry', () => {
    const whitelist = allow('cosmospay://auth');
    expect(
      assertPollarRedirectAllowed(
        CONSUMER,
        'cosmospay://auth/callback',
        whitelist,
      ),
    ).toBe('cosmospay://auth/callback');
  });

  it('does not let a scheme entry cover a look-alike sibling', () => {
    const whitelist = allow('cosmospay://auth');
    expect(rejects('cosmospay://authorize', whitelist)).toThrow(/not allowed/);
    expect(rejects('cosmospay-evil://auth', whitelist)).toThrow(/not allowed/);
  });

  it('matches an https entry on host, including subdomains', () => {
    const whitelist = allow('https://acme.com');
    expect(
      assertPollarRedirectAllowed(
        CONSUMER,
        'https://app.acme.com/cb',
        whitelist,
      ),
    ).toBe('https://app.acme.com/cb');
    expect(rejects('https://acme.com.evil.test/cb', whitelist)).toThrow(
      /not allowed/,
    );
  });

  it('accepts a bare hostname entry as https, the way the KYC list reads', () => {
    expect(
      assertPollarRedirectAllowed(
        CONSUMER,
        'https://app.acme.com/cb',
        allow('acme.com'),
      ),
    ).toBe('https://app.acme.com/cb');
  });

  it('refuses embedded credentials and fragments', () => {
    const whitelist = allow('https://acme.com');
    expect(rejects('https://u:p@acme.com/cb', whitelist)).toThrow(
      /embedded credentials/,
    );
    expect(rejects('https://acme.com/cb#frag', whitelist)).toThrow(/fragment/);
  });

  it('fails closed for a consumer with no configured entries', () => {
    expect(rejects('https://acme.com/cb', {})).toThrow(
      /no Pollar redirect_uri values are configured/,
    );
  });

  it('rejects a non-absolute URI', () => {
    expect(rejects('/cb', allow('https://acme.com'))).toThrow(
      /must be an absolute URI/,
    );
  });
});

describe('buildWalletRedirect', () => {
  it('appends code and state', () => {
    expect(
      buildWalletRedirect('cosmospay://auth/cb', { code: 'abc', state: 'xyz' }),
    ).toBe('cosmospay://auth/cb?code=abc&state=xyz');
  });

  it('keeps a query the registered URI already carried', () => {
    expect(
      buildWalletRedirect('https://acme.com/cb?flow=signup', { code: 'abc' }),
    ).toBe('https://acme.com/cb?flow=signup&code=abc');
  });
});
