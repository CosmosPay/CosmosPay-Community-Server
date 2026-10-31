import {
  oidcSourceProblem,
  parseOidcSources,
} from '@/wallet-auth/oidc-sources';

describe('WALLET_AUTH_OIDC_SOURCES', () => {
  it('reads slug:Label pairs, trimming around both', () => {
    expect(parseOidcSources(' google:Google , github: GitHub ')).toEqual([
      { slug: 'google', name: 'Google' },
      { slug: 'github', name: 'GitHub' },
    ]);
  });

  it('is empty when unset', () => {
    expect(parseOidcSources(undefined)).toEqual([]);
    expect(parseOidcSources(' , ')).toEqual([]);
  });

  it('accepts a well-formed entry', () => {
    expect(oidcSourceProblem({ slug: 'google', name: 'Google' })).toBeNull();
  });

  it('accepts the emailed sign-in link next to the sources', () => {
    const sources = parseOidcSources('google:Google,github:GitHub,email:Email');
    expect(sources[2]).toEqual({ slug: 'email', name: 'Email' });
    expect(sources.map(oidcSourceProblem)).toEqual([null, null, null]);
  });

  it('refuses an entry without a label', () => {
    expect(parseOidcSources('google').map(oidcSourceProblem)[0]).toMatch(
      /no label/,
    );
  });

  it('refuses a slug Authentik would not have', () => {
    expect(oidcSourceProblem({ slug: 'Google', name: 'Google' })).toMatch(
      /slug/,
    );
    expect(oidcSourceProblem({ slug: 'a/b', name: 'x' })).toMatch(/slug/);
  });

  it('refuses a label too long for a button', () => {
    expect(oidcSourceProblem({ slug: 'g', name: 'x'.repeat(41) })).toMatch(
      /longer/,
    );
  });
});
