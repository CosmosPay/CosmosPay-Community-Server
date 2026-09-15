import type { Request } from 'express';
import { headerValue } from '@/common/request-header';

function requestWith(
  headers: Record<string, string | string[] | undefined>,
): Request {
  return { headers } as unknown as Request;
}

describe('headerValue', () => {
  it('returns a single value exactly as sent', () => {
    expect(
      headerValue(
        requestWith({ 'idempotency-key': ' k-1 ' }),
        'idempotency-key',
      ),
    ).toBe(' k-1 ');
  });

  it('takes the first value of a repeated header', () => {
    expect(
      headerValue(requestWith({ 'svix-id': ['msg_1', 'msg_2'] }), 'svix-id'),
    ).toBe('msg_1');
  });

  it('is undefined when the header is absent', () => {
    expect(headerValue(requestWith({}), 'idempotency-key')).toBeUndefined();
    expect(
      headerValue(requestWith({ 'svix-id': [] }), 'svix-id'),
    ).toBeUndefined();
  });
});
