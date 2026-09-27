import type { NextFunction, Request, Response } from 'express';

/**
 * Open CORS on the endpoints that belong to a standard: SEP-1's TOML, SEP-10 and
 * SEP-30.
 *
 * Both specs require it — the client reading them is a browser wallet on some
 * other origin, and a TOML nobody may fetch discovers nothing. `*` is safe here
 * in a way it would not be elsewhere: no route under these prefixes reads a
 * cookie. The credential is a bearer token the caller holds and sends
 * deliberately, and `*` never admits credentialed requests anyway.
 *
 * Answered here rather than by the gateway's CORS plugin, which lists specific
 * origins for the rest of the API. APISIX serves these prefixes on a keyless
 * route WITHOUT that plugin (see the developer platform's `utils/apisix.ts`), so
 * exactly one party writes the header — two would send two values, and a browser
 * refuses a response that has both.
 */
const PREFIXES = ['/.well-known/stellar.toml', '/v1/sep10/', '/v1/sep30/'];

export function isSepPath(path: string): boolean {
  return PREFIXES.some(
    (p) => path === p.replace(/\/$/, '') || path.startsWith(p),
  );
}

export function sepCors(req: Request, res: Response, next: NextFunction): void {
  if (!isSepPath(req.path)) return next();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  // X-Cosmos-Trace-Id is the Cosmos wallet's per-request correlation id. It has
  // to be listed or the PREFLIGHT fails and the browser never sends the call —
  // green in the extension (host_permissions skip CORS), dead on the web.
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization,Content-Type,X-Cosmos-Trace-Id',
  );
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  res.setHeader('Access-Control-Max-Age', '86400');
  // helmet's default is `same-origin`, which a browser applies to the response of
  // a cross-origin read and refuses it.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}
