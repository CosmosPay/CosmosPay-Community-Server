import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { StellarNetwork } from '@/config/configuration';

/**
 * Which ledger a recovery request is for.
 *
 * One recovery server serves every ledger the operator lists in
 * `RECOVERY_NETWORKS`, and a request names one with a segment right after the
 * SEP prefix:
 *
 *   /v1/sep10/testnet/auth          /v1/sep30/testnet/accounts/G…
 *   /.well-known/stellar.toml?network=testnet
 *
 * Inside the existing prefixes rather than in front of them, because the gateway
 * routes `/v1/sep10/*` and `/v1/sep30/*` to this service on a keyless route, and
 * `sepCors` opens CORS on exactly those prefixes: a `/testnet/v1/…` path would
 * need a gateway route nobody deployed, and would fail as a CORS error in a
 * browser before it ever reached a log. A request with no segment is the
 * default ledger (`RECOVERY_NETWORK_PASSPHRASE`), exactly as before.
 *
 * The segment is taken off here, before routing, so every controller keeps its
 * one path; the ledger rides on the request for `@RecoveryNetwork()` to read.
 */

const SEGMENTED = /^\/v1\/(sep10|sep30)\/(public|testnet)(?=\/|$)/;

type WithNetwork = Request & { recoveryNetwork?: StellarNetwork };

export function recoveryNetworkRewrite(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const match = SEGMENTED.exec(req.url);
  if (match) {
    (req as WithNetwork).recoveryNetwork = match[2] as StellarNetwork;
    req.url = `/v1/${match[1]}${req.url.slice(match[0].length)}`;
  }
  next();
}

/** The ledger the request named, or null for the default one. */
export const RecoveryNetwork = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): StellarNetwork | null => {
    const req = ctx.switchToHttp().getRequest<WithNetwork>();
    return req.recoveryNetwork ?? null;
  },
);

/** `?network=` on the TOML: a named ledger, null for none, undefined for junk. */
export function tomlNetwork(raw: unknown): StellarNetwork | null | undefined {
  if (raw === undefined || raw === '') return null;
  return raw === 'public' || raw === 'testnet' ? raw : undefined;
}
