import { parseRedirectUrlWhitelist } from '@/config/kyc-redirect-url-whitelist';

describe('parseRedirectUrlWhitelist', () => {
  it('returns empty map for missing or invalid input', () => {
    expect(parseRedirectUrlWhitelist(undefined)).toEqual({});
    expect(parseRedirectUrlWhitelist('')).toEqual({});
    expect(parseRedirectUrlWhitelist('not-json')).toEqual({});
    expect(parseRedirectUrlWhitelist('[]')).toEqual({});
  });

  it('parses consumer → domains map', () => {
    expect(
      parseRedirectUrlWhitelist(
        JSON.stringify({
          cosmos_acme: ['acme.com', 'APP.ACME.COM'],
          cosmos_empty: [],
        }),
      ),
    ).toEqual({
      cosmos_acme: ['acme.com', 'app.acme.com'],
      cosmos_empty: [],
    });
  });
});
