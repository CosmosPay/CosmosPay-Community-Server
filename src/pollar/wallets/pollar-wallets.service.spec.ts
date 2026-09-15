import { PollarApiError } from '@/pollar/pollar.client';
import { PollarWalletsService } from '@/pollar/wallets/pollar-wallets.service';

const CONSUMER = { username: 'cosmos_acme', role: 'user' } as any;
const ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const OTHER_ADDRESS =
  'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

/** Rows the ownership check can find, in the two tables it reads. */
interface Records {
  sessions?: Array<{
    consumerId: string;
    network: string;
    walletAddress: string | null;
  }>;
  wallets?: Array<Record<string, unknown>>;
}

/** Equality on every key of `where` — all the ownership check asks of Prisma. */
const firstMatch = (rows: any[], where: Record<string, unknown>) =>
  rows.find((row) =>
    Object.entries(where).every(([key, value]) => row[key] === value),
  ) ?? null;

/**
 * By default the caller — local consumer `c1`, on testnet, which is config's
 * network since CONSUMER carries no environment — redeemed a login that
 * returned ADDRESS: the ordinary way a wallet reaches these routes.
 */
function makeService(
  records: Records = {
    sessions: [
      { consumerId: 'c1', network: 'testnet', walletAddress: ADDRESS },
    ],
  },
  localConsumerId = 'c1',
) {
  const sessions = records.sessions ?? [];
  const wallets = records.wallets ?? [];
  const pollar: any = { server: jest.fn() };
  const config: any = { get: jest.fn(() => ({ network: 'testnet' })) };
  const prisma: any = {
    pollarOauthSession: {
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(firstMatch(sessions, where)),
      ),
    },
    pollarUserWallet: {
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(firstMatch(wallets, where)),
      ),
      upsert: jest.fn(({ create }: any) => {
        wallets.push(create);
        return Promise.resolve(create);
      }),
    },
  };
  const consumers: any = {
    resolve: jest.fn().mockResolvedValue({ id: localConsumerId }),
  };
  return {
    service: new PollarWalletsService(pollar, config, prisma, consumers),
    pollar,
    prisma,
  };
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

describe('wallet ownership', () => {
  /** Every route that names a wallet, over a given address. */
  const ROUTES: Array<
    [string, (service: PollarWalletsService, address: string) => Promise<any>]
  > = [
    ['activate', (s, a) => s.activate(CONSUMER, { public_key: a })],
    ['defaultTrustlines', (s, a) => s.defaultTrustlines(CONSUMER, a)],
    [
      'createTrustlines',
      (s, a) =>
        s.createTrustlines(CONSUMER, a, {
          assets: [{ code: 'USDC', issuer: OTHER_ADDRESS }],
        }),
    ],
    [
      'removeTrustline',
      (s, a) => s.removeTrustline(CONSUMER, a, 'USDC', OTHER_ADDRESS),
    ],
  ];

  it.each(ROUTES)(
    '%s refuses another tenant’s wallet without asking Pollar',
    async (_route, call) => {
      // Tenant A (`c1`) logged in and holds ADDRESS; tenant B (`c2`) names it.
      const { service, pollar } = makeService(undefined, 'c2');

      await expect(call(service, ADDRESS)).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      });
      // Pollar would have obeyed — every tenant holds the same keys — so the
      // refusal has to happen before it is asked.
      expect(pollar.server).not.toHaveBeenCalled();
    },
  );

  it('answers another tenant’s wallet exactly as it answers an unknown one', async () => {
    const { service } = makeService(undefined, 'c2');

    const foreign = await service
      .defaultTrustlines(CONSUMER, ADDRESS)
      .catch((err: unknown) => err);
    const unknown = await service
      .defaultTrustlines(CONSUMER, OTHER_ADDRESS)
      .catch((err: unknown) => err);

    // Any difference — a 403, a different message — tells tenant B that the
    // address is live for somebody.
    expect(foreign).toMatchObject({ status: 404 });
    expect(unknown).toMatchObject({ status: 404 });
    expect((foreign as Error).message).toBe((unknown as Error).message);
  });

  it('does not carry a login over to the other network', async () => {
    // Pollar's mainnet and testnet are separate applications; an address a
    // mainnet login returned is not a testnet wallet of this tenant's.
    const { service, pollar } = makeService({
      sessions: [
        { consumerId: 'c1', network: 'public', walletAddress: ADDRESS },
      ],
    });

    await expect(
      service.defaultTrustlines(CONSUMER, ADDRESS),
    ).rejects.toMatchObject({ status: 404 });
    expect(pollar.server).not.toHaveBeenCalled();
  });

  it('accepts a wallet provisioned for this consumer on a counterpart network', async () => {
    const { service, pollar } = makeService({
      wallets: [
        { consumerId: 'c1', network: 'testnet', address: OTHER_ADDRESS },
      ],
    });
    pollar.server.mockResolvedValue({});

    await expect(
      service.defaultTrustlines(CONSUMER, OTHER_ADDRESS),
    ).resolves.toEqual({ code: 'SERVER_TRUSTLINES_ENABLED' });
  });

  it('recognises a wallet from users/with-wallet on the very next call', async () => {
    const { service, pollar, prisma } = makeService({});
    pollar.server
      .mockResolvedValueOnce({
        userId: 'usr_pollar_1',
        wallet: { type: 'internal', publicKey: OTHER_ADDRESS },
      })
      .mockResolvedValueOnce({});

    await service.registerUser(CONSUMER, { external_id: 'usr_7Kd2' }, true);

    expect(prisma.pollarUserWallet.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          consumerId: 'c1',
          externalId: 'usr_7Kd2',
          network: 'testnet',
          status: 'READY',
          address: OTHER_ADDRESS,
        }),
      }),
    );
    // Without that record the route that just handed the address out would
    // refuse its own wallet one call later.
    await expect(
      service.defaultTrustlines(CONSUMER, OTHER_ADDRESS),
    ).resolves.toEqual({ code: 'SERVER_TRUSTLINES_ENABLED' });
  });

  it('still returns the new user when the wallet cannot be recorded', async () => {
    const { service, pollar, prisma } = makeService({});
    pollar.server.mockResolvedValue({
      id: 'usr_1',
      wallet: { type: 'internal', address: OTHER_ADDRESS },
    });
    prisma.pollarUserWallet.upsert.mockRejectedValue(new Error('db down'));

    // The user and wallet already exist at Pollar; failing here would only send
    // the caller into a retry that Pollar refuses as a duplicate.
    await expect(
      service.registerUser(CONSUMER, { external_id: 'usr_7Kd2' }, true),
    ).resolves.toMatchObject({ wallet: { address: OTHER_ADDRESS } });
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
    const { service, pollar, prisma } = makeService();
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
    // Nothing to own without an address, so nothing is recorded either.
    expect(prisma.pollarUserWallet.upsert).not.toHaveBeenCalled();
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
