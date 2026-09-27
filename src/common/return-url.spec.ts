import {
  isReturnUrlAllowed,
  parseReturnUrls,
  returnRedirectUrl,
  returnUrlProblem,
} from '@/common/return-url';

const ALLOW = [
  'cosmoswallet://auth/done',
  'https://wallet.example.com/auth/done',
  'http://127.0.0.1/auth/done',
];

describe('returnUrlProblem', () => {
  it.each([
    'cosmoswallet://auth/done',
    'https://wallet.example.com/auth/done',
    'http://127.0.0.1:53682/auth/done',
    'http://[::1]/auth/done',
  ])('accepts %s', (url) => {
    expect(returnUrlProblem(url)).toBeNull();
  });

  it.each([
    ['not a url', 'is not an absolute URL'],
    ['/auth/done', 'is not an absolute URL'],
    ['javascript://auth/done', 'uses the javascript: scheme'],
    ['data://auth/done', 'uses the data: scheme'],
    ['file:///etc/passwd', 'uses the file: scheme'],
    ['https://user:pw@wallet.example.com/done', 'carries credentials'],
    ['cosmoswallet://auth/done?x=1', 'carries a query or fragment'],
    ['cosmoswallet://auth/done#x', 'carries a query or fragment'],
  ])('refuses %s', (url, problem) => {
    expect(returnUrlProblem(url)).toBe(problem);
  });

  it('refuses plain http anywhere but the loopback literal', () => {
    expect(returnUrlProblem('http://wallet.example.com/done')).toMatch(
      /plain http/,
    );
    // RFC 8252 §8.3: the literal, not a name that could resolve elsewhere.
    expect(returnUrlProblem('http://localhost/done')).toMatch(/plain http/);
  });
});

describe('isReturnUrlAllowed', () => {
  it('matches an allowlisted URL exactly', () => {
    expect(isReturnUrlAllowed('cosmoswallet://auth/done', ALLOW)).toBe(true);
    expect(
      isReturnUrlAllowed('https://wallet.example.com/auth/done', ALLOW),
    ).toBe(true);
  });

  it('ignores the port against a loopback entry only', () => {
    expect(isReturnUrlAllowed('http://127.0.0.1:53682/auth/done', ALLOW)).toBe(
      true,
    );
    expect(
      isReturnUrlAllowed('https://wallet.example.com:8443/auth/done', ALLOW),
    ).toBe(false);
  });

  it.each([
    'cosmoswallet://auth/other',
    'otherwallet://auth/done',
    'https://evil.example.com/auth/done',
    'https://wallet.example.com.evil.com/auth/done',
    'https://wallet.example.com/auth/done/',
    'http://127.0.0.1:53682/elsewhere',
    'cosmoswallet://auth/done?redirect=https://evil.example.com',
  ])('refuses %s', (url) => {
    expect(isReturnUrlAllowed(url, ALLOW)).toBe(false);
  });

  it('allows nothing with an empty list', () => {
    expect(isReturnUrlAllowed('cosmoswallet://auth/done', [])).toBe(false);
  });

  it('never matches through an allowlist entry that is itself invalid', () => {
    expect(
      isReturnUrlAllowed('javascript://auth/done', ['javascript://auth/done']),
    ).toBe(false);
  });
});

describe('returnRedirectUrl', () => {
  it('carries only the state on success', () => {
    expect(returnRedirectUrl('cosmoswallet://auth/done', 'st4te', 'ok')).toBe(
      'cosmoswallet://auth/done?state=st4te',
    );
  });

  it('adds the reason token on failure', () => {
    expect(
      returnRedirectUrl('http://127.0.0.1:53682/auth/done', 'st4te', 'denied'),
    ).toBe('http://127.0.0.1:53682/auth/done?state=st4te&error=denied');
  });
});

describe('parseReturnUrls', () => {
  it('splits, trims and drops empties', () => {
    expect(parseReturnUrls(' a://x/y , ,https://b/c ')).toEqual([
      'a://x/y',
      'https://b/c',
    ]);
    expect(parseReturnUrls(undefined)).toEqual([]);
  });
});
