import { BadRequestException } from '@nestjs/common';
import {
  assertRedirectAllowed,
  hostnameAllowed,
} from '@/kyc/redirect-url-whitelist';

describe('hostnameAllowed', () => {
  it('allows exact and label-safe subdomain matches', () => {
    expect(hostnameAllowed('app.acme.com', ['acme.com'])).toBe(true);
    expect(hostnameAllowed('acme.com', ['acme.com'])).toBe(true);
  });

  it('rejects lookalike hosts', () => {
    expect(hostnameAllowed('evilacme.com', ['acme.com'])).toBe(false);
    expect(hostnameAllowed('acme.com.evil.com', ['acme.com'])).toBe(false);
  });
});

describe('assertRedirectAllowed', () => {
  const whitelist = {
    cosmos_acme: ['acme.com'],
  };

  it('allows a redirect_url on a permitted domain', () => {
    expect(() =>
      assertRedirectAllowed(
        'cosmos_acme',
        'https://app.acme.com/kyc/return',
        whitelist,
      ),
    ).not.toThrow();
  });

  it('rejects a redirect_url on a non-permitted domain', () => {
    expect(() =>
      assertRedirectAllowed(
        'cosmos_acme',
        'https://evil.com/kyc/return',
        whitelist,
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      assertRedirectAllowed(
        'cosmos_acme',
        'https://evil.com/kyc/return',
        whitelist,
      ),
    ).toThrow(/not allowed for this consumer/i);
  });

  it('rejects when the consumer has no configured domains', () => {
    expect(() =>
      assertRedirectAllowed(
        'cosmos_unknown',
        'https://app.acme.com/kyc/return',
        whitelist,
      ),
    ).toThrow(/no redirect_url domains are configured/i);
  });
});
