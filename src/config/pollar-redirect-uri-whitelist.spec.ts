import { parsePollarRedirectWhitelist } from '@/config/pollar-redirect-uri-whitelist';

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
