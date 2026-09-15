import { HttpStatus } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  assertRedirectAllowed,
  hostnameAllowed,
} from '@/kyc/redirect-url-whitelist';

/** What `fn` throws, so its status and code can be asserted, not just its class. */
function thrown(fn: () => void): ApiError {
  try {
    fn();
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('expected the call to throw');
}

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
    const err = thrown(() =>
      assertRedirectAllowed(
        'cosmos_acme',
        'https://evil.com/kyc/return',
        whitelist,
      ),
    );

    expect(err).toBeInstanceOf(ApiError);
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.code).toBe(ApiErrorCode.ValidationFailed);
    expect(err.message).toMatch(/not allowed for this consumer/i);
  });

  it('rejects a redirect_url that is not a URL', () => {
    const err = thrown(() =>
      assertRedirectAllowed('cosmos_acme', 'not a url', whitelist),
    );

    expect(err.code).toBe(ApiErrorCode.ValidationFailed);
    expect(err.message).toMatch(/must be a valid https URL/i);
  });

  it('rejects when the consumer has no configured domains', () => {
    const err = thrown(() =>
      assertRedirectAllowed(
        'cosmos_unknown',
        'https://app.acme.com/kyc/return',
        whitelist,
      ),
    );

    expect(err.code).toBe(ApiErrorCode.ValidationFailed);
    expect(err.message).toMatch(/no redirect_url domains are configured/i);
  });
});
