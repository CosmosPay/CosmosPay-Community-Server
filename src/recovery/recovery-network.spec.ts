import type { Request, Response } from 'express';
import {
  recoveryNetworkRewrite,
  tomlNetwork,
} from '@/recovery/recovery-network';

function run(url: string) {
  const req = { url } as Request & { recoveryNetwork?: string };
  const next = jest.fn();
  recoveryNetworkRewrite(req, {} as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  return { url: req.url, network: req.recoveryNetwork };
}

describe('recoveryNetworkRewrite', () => {
  it('takes the ledger segment off a SEP-10 or SEP-30 path', () => {
    expect(run('/v1/sep10/testnet/auth?account=G')).toEqual({
      url: '/v1/sep10/auth?account=G',
      network: 'testnet',
    });
    expect(run('/v1/sep30/public/accounts/GABC/sign/GDEF')).toEqual({
      url: '/v1/sep30/accounts/GABC/sign/GDEF',
      network: 'public',
    });
    expect(run('/v1/sep30/testnet/shares/GABC')).toEqual({
      url: '/v1/sep30/shares/GABC',
      network: 'testnet',
    });
  });

  it('leaves a path with no segment — the default ledger — untouched', () => {
    expect(run('/v1/sep30/accounts')).toEqual({
      url: '/v1/sep30/accounts',
      network: undefined,
    });
  });

  /* Only the two names, and only inside the SEP prefixes: anything else is not
     a ledger, and the router answers it as the path it is. */
  it('rewrites nothing else', () => {
    for (const url of [
      '/v1/sep30/testnetx/accounts',
      '/v1/sep30/futurenet/accounts',
      '/v1/wallet/testnet/finish',
      '/testnet/v1/sep30/accounts',
    ]) {
      expect(run(url)).toEqual({ url, network: undefined });
    }
  });
});

describe('tomlNetwork', () => {
  it('reads a named ledger, none, or junk', () => {
    expect(tomlNetwork('testnet')).toBe('testnet');
    expect(tomlNetwork('public')).toBe('public');
    expect(tomlNetwork(undefined)).toBeNull();
    expect(tomlNetwork('')).toBeNull();
    expect(tomlNetwork('mainnet')).toBeUndefined();
  });
});
