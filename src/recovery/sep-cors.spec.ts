import type { NextFunction, Request, Response } from 'express';
import { isSepPath, sepCors } from '@/recovery/sep-cors';

function run(path: string, method = 'GET') {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (k: string, v: string) => (headers[k.toLowerCase()] = v),
    status: jest.fn().mockReturnThis(),
    end: jest.fn(),
  };
  const next = jest.fn() as NextFunction;
  sepCors({ path, method } as Request, res as unknown as Response, next);
  return { headers, res, next };
}

describe('sepCors', () => {
  it('opens exactly the standard prefixes', () => {
    expect(isSepPath('/.well-known/stellar.toml')).toBe(true);
    expect(isSepPath('/v1/sep10/auth')).toBe(true);
    expect(isSepPath('/v1/sep30/accounts')).toBe(true);
    expect(isSepPath('/v1/swaps')).toBe(false);
    expect(isSepPath('/v1/sep300')).toBe(false);
  });

  it('leaves every other route to the gateway', () => {
    const { headers, next } = run('/v1/wallet/auth/providers');
    expect(headers).toEqual({});
    expect(next).toHaveBeenCalled();
  });

  it("admits the wallet's trace header, or its preflight fails", () => {
    const { headers } = run('/v1/sep30/accounts', 'OPTIONS');
    expect(headers['access-control-allow-headers']).toContain(
      'X-Cosmos-Trace-Id',
    );
    expect(headers['access-control-allow-origin']).toBe('*');
  });

  it('answers a preflight itself', () => {
    const { res, next } = run('/v1/sep10/auth', 'OPTIONS');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(next).not.toHaveBeenCalled();
  });
});
