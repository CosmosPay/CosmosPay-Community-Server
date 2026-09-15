import type { Request } from 'express';

/**
 * The first value of a request header, or `undefined` when it is absent.
 *
 * Node types a header as `string | string[] | undefined`, so every reader has to
 * collapse it. The swaps and liquidity-pools controllers each carried a private
 * copy of this, and the BlindPay webhook a third that defaulted to `''` instead —
 * three spellings of one rule.
 *
 * `name` must be lower-case: Node lower-cases header keys on the way in. The
 * value comes back as sent, untrimmed, because a signature header is compared
 * byte for byte.
 */
export function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}
