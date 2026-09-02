import { PollarApiError } from '@/pollar/pollar.client';
import { PollarWalletsService } from '@/pollar/wallets/pollar-wallets.service';

const CONSUMER = { username: 'cosmos_acme', role: 'user' } as any;
const ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function makeService() {
  const pollar: any = { server: jest.fn() };
  const config: any = { get: jest.fn(() => ({ network: 'testnet' })) };
  return { service: new PollarWalletsService(pollar, config), pollar };
}

describe('activate', () => {
  it('reports the funded reserve', async () => {
    const { service, pollar } = makeService();
    pollar.server.mockResolvedValue({ publicKey: ADDRESS, amount: '1.5' });

    await expect(
      service.activate(CONSUMER, { public_key: ADDRESS } as any),
    ).resolves.toEqual({ public_key: ADDRESS, amount: '1.5', activated: true });
  });

  it('treats an already-funded wallet as a success, not an error', async () => {
    const { service, pollar } = makeService();
    pollar.server.mockRejectedValue(
      new PollarApiError(409, 'WALLET_ALREADY_FUNDED', 'already funded'),
    );

    // Activation is idempotent at Pollar, and the caller asked for a funded
    // wallet — which they have. Surfacing a 409 would make every retry a
    // special case at every call site.
    await expect(
      service.activate(CONSUMER, { public_key: ADDRESS } as any),
    ).resolves.toMatchObject({ activated: false });
  });

  it('relays a real failure with Pollar’s own code', async () => {
    const { service, pollar } = makeService();
    pollar.server.mockRejectedValue(
      new PollarApiError(404, 'WALLET_NOT_FOUND', 'nope'),
    );

    await expect(
      service.activate(CONSUMER, { public_key: ADDRESS } as any),
    ).rejects.toThrow(/WALLET_NOT_FOUND/);
  });
});

describe('trustlines', () => {
  it('reports the code the route it called actually produces', async () => {
    const { service, pollar } = makeService();
    pollar.server.mockResolvedValue({});

    await expect(service.defaultTrustlines(CONSUMER, ADDRESS)).resolves.toEqual(
      { code: 'SERVER_TRUSTLINES_ENABLED' },
    );
    // Removal is a different outcome and has a different code; reporting the
    // "enabled" one here said the opposite of what happened.
    await expect(
      service.removeTrustline(CONSUMER, ADDRESS, 'USDC', ADDRESS),
    ).resolves.toEqual({ code: 'SERVER_TRUSTLINE_DISABLED' });
  });

  it('joins code and issuer into the single segment Pollar expects', async () => {
    const { service, pollar } = makeService();
    pollar.server.mockResolvedValue({});

    await service.removeTrustline(CONSUMER, ADDRESS, 'USDC', ADDRESS);

    const [method, , path] = pollar.server.mock.calls[0];
    expect(method).toBe('DELETE');
    expect(path).toBe(`/wallets/${ADDRESS}/trustlines/USDC:${ADDRESS}`);
  });
});

describe('registerUser', () => {
  it('projects the response instead of relaying an undocumented payload', async () => {
    const { service, pollar } = makeService();
    pollar.server.mockResolvedValue({
      id: 'usr_pollar_1',
      // Pollar does not publish this route's content shape, so anything we did
      // not ask for is dropped rather than republished as our contract.
      internalNote: 'do not surface',
      email: 'ada@example.com',
    });

    const user = await service.registerUser(
      CONSUMER,
      { external_id: 'usr_7Kd2', email: 'ada@example.com' },
      false,
    );

    expect(user).toEqual({
      external_id: 'usr_7Kd2',
      code: 'SERVER_USER_REGISTERED',
      user_id: 'usr_pollar_1',
    });
    expect(JSON.stringify(user)).not.toContain('do not surface');
  });

  it('maps the wallet on the with-wallet route', async () => {
    const { service, pollar } = makeService();
    pollar.server.mockResolvedValue({
      userId: 'usr_pollar_1',
      wallet: { type: 'internal', publicKey: ADDRESS, existsOnStellar: true },
    });

    const user = await service.registerUser(
      CONSUMER,
      { external_id: 'usr_7Kd2' },
      true,
    );

    expect(pollar.server.mock.calls[0][2]).toBe('/users/with-wallet');
    expect(user.code).toBe('SERVER_USER_WALLET_CREATED');
    // `publicKey` is the classic-address spelling; `address` is the other.
    expect(user.wallet).toEqual({
      type: 'internal',
      address: ADDRESS,
      chain: undefined,
      exists_on_stellar: true,
      funding_mode: undefined,
      network: undefined,
    });
  });

  it('omits a wallet whose shape drifted rather than half-building one', async () => {
    const { service, pollar } = makeService();
    pollar.server.mockResolvedValue({
      id: 'usr_1',
      wallet: { type: 'internal' },
    });

    const user = await service.registerUser(
      CONSUMER,
      { external_id: 'usr_7Kd2' },
      true,
    );

    expect(user.wallet).toBeUndefined();
  });
});

describe('verifyToken', () => {
  it('returns what Pollar vouches for, wallet included', async () => {
    const { service, pollar } = makeService();
    pollar.server.mockResolvedValue({
      userId: 'usr_1',
      applicationId: 'app_1',
      expiresAt: 1788350400000,
      network: 'testnet',
      authProvider: 'google',
      wallet: { type: 'internal', address: ADDRESS },
    });

    const claims = await service.verifyToken(CONSUMER, {
      token: 't'.repeat(20),
    });

    expect(claims).toMatchObject({
      user_id: 'usr_1',
      application_id: 'app_1',
      auth_provider: 'google',
    });
    expect(claims.wallet?.address).toBe(ADDRESS);
  });

  it('relays an expired token as Pollar reported it', async () => {
    const { service, pollar } = makeService();
    pollar.server.mockRejectedValue(
      new PollarApiError(401, 'SDK_AUTH_TOKEN_EXPIRED', 'expired'),
    );

    await expect(
      service.verifyToken(CONSUMER, { token: 't'.repeat(20) } as any),
    ).rejects.toThrow(/SDK_AUTH_TOKEN_EXPIRED/);
  });
});
