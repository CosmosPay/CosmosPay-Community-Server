import { createHash } from 'node:crypto';
import { PollarApiError } from '@/pollar/pollar.client';
import { PollarOauthService } from '@/pollar/oauth/pollar-oauth.service';
import { hashCode } from '@/pollar/oauth/pollar-oauth-code';

const CONSUMER = { username: 'cosmos_acme', role: 'user' } as any;

const POLLAR_CONFIG = {
  publishableKey: { public: 'pub_mainnet_x', testnet: 'pub_testnet_x' },
  secretKey: { public: 'sec_mainnet_x', testnet: 'sec_testnet_x' },
  sdkBaseUrl: 'https://sdk.api.pollar.xyz',
  serverBaseUrl: 'https://api.pollar.xyz',
  bridgeCallbackUrl: 'https://gw.test/v1/pollar/oauth/callback',
  redirectUriWhitelist: { cosmos_acme: ['cosmospay://auth'] },
  timeoutMs: 1000,
  authorizationTtlMs: 300_000,
  codeTtlMs: 120_000,
  // Short, so the "still not ready" path resolves without a real wait.
  loginWaitMs: 400,
  sweep: { enabled: false, intervalMs: 60_000 },
};

const LOGIN_CONTENT = {
  clientSessionId: 'cs_1',
  userId: 'usr_1',
  status: 'CONSUMED',
  token: {
    accessToken: 'at_1',
    refreshToken: 'rt_1',
    expiresAt: 1788350400000,
  },
  wallet: {
    type: 'internal',
    address: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    chain: 'STELLAR',
    existsOnStellar: true,
    fundingMode: 'IMMEDIATE',
    network: 'testnet',
  },
  data: { mail: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' },
};

/**
 * An in-memory stand-in for the `pollar_oauth_session` table.
 *
 * `updateMany` honours its `where` the way Postgres does, because that is the
 * whole mechanism under test: every transition in the bridge is a
 * compare-and-swap, and a fake that ignored the status predicate would make the
 * single-use guarantee untestable.
 */
function makeTable() {
  const rows: any[] = [];
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
      if (value && typeof value === 'object' && 'in' in value) {
        return (value.in as unknown[]).includes(row[key]);
      }
      return row[key] === value;
    });

  return {
    rows,
    create: jest.fn(({ data }: any) => {
      const row = {
        id: `s${rows.length + 1}`,
        status: 'PENDING',
        redirectUri: null,
        codeChallenge: null,
        dpopJwk: null,
        deviceLabel: null,
        codeHash: null,
        codeExpiresAt: null,
        errorCode: null,
        ...data,
      };
      rows.push(row);
      return Promise.resolve(row);
    }),
    findUnique: jest.fn(({ where }: any) =>
      Promise.resolve(rows.find((row) => matches(row, where)) ?? null),
    ),
    updateMany: jest.fn(({ where, data }: any) => {
      const hits = rows.filter((row) => matches(row, where));
      for (const row of hits) Object.assign(row, data);
      return Promise.resolve({ count: hits.length });
    }),
    update: jest.fn(({ where, data }: any) => {
      const row = rows.find((r) => matches(r, where));
      Object.assign(row, data);
      return Promise.resolve(row);
    }),
  };
}

function makeService(overrides: Partial<typeof POLLAR_CONFIG> = {}) {
  const table = makeTable();
  const prisma: any = { pollarOauthSession: table };
  const pollar: any = {
    sdk: jest.fn(),
    sdkBase: () => 'https://sdk.api.pollar.xyz/v2',
    publishableKey: () => 'pub_testnet_x',
    callbackUrl: (state: string) =>
      `${POLLAR_CONFIG.bridgeCallbackUrl}/${state}`,
  };
  const consumers: any = { resolve: jest.fn().mockResolvedValue({ id: 'c1' }) };
  const config: any = {
    get: jest.fn((key: string) =>
      key === 'pollar'
        ? { ...POLLAR_CONFIG, ...overrides }
        : { network: 'testnet' },
    ),
  };
  const service = new PollarOauthService(prisma, pollar, consumers, config);
  return { service, table, pollar };
}

/** Runs a handshake up to the point where a code exists. */
async function authorized(
  opts: { redirectUri?: string; codeChallenge?: string } = {},
) {
  const ctx = makeService();
  ctx.pollar.sdk.mockResolvedValueOnce({ clientSessionId: 'cs_1' });
  const auth = await ctx.service.authorize(CONSUMER, {
    provider: 'google',
    ...(opts.redirectUri ? { redirect_uri: opts.redirectUri } : {}),
    ...(opts.codeChallenge ? { code_challenge: opts.codeChallenge } : {}),
  } as any);
  const callback = await ctx.service.handleCallback(auth.state);
  return { ...ctx, auth, callback };
}

/** The `code` the bridge put on a redirect URI. */
function codeFromRedirect(redirectTo: string): string {
  return new URL(redirectTo).searchParams.get('code')!;
}

describe('authorize', () => {
  it('assembles the Pollar URL so the wallet holds none of its parts', async () => {
    const { auth } = await authorized({ redirectUri: 'cosmospay://auth/cb' });
    const url = new URL(auth.authorization_url);

    expect(url.pathname).toBe('/v2/auth/google');
    expect(url.searchParams.get('api_key')).toBe('pub_testnet_x');
    expect(url.searchParams.get('client_session_id')).toBe('cs_1');
    // Pollar returns the browser to the BRIDGE, never to the wallet — that
    // indirection is the entire reason this service exists.
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${POLLAR_CONFIG.bridgeCallbackUrl}/${auth.state}`,
    );
  });

  it('refuses a redirect URI the consumer has not registered', async () => {
    const { service, pollar } = makeService();
    pollar.sdk.mockResolvedValue({ clientSessionId: 'cs_1' });
    await expect(
      service.authorize(CONSUMER, {
        provider: 'google',
        redirect_uri: 'https://evil.test/cb',
      } as any),
    ).rejects.toThrow(/not allowed/);
    // Rejected before a Pollar session was spent on it.
    expect(pollar.sdk).not.toHaveBeenCalled();
  });

  it('stores no token and no secret — only a state and a session id', async () => {
    const { table } = await authorized({ redirectUri: 'cosmospay://auth/cb' });
    const row = table.rows[0];
    expect(row.clientSessionId).toBe('cs_1');
    expect(JSON.stringify(row)).not.toContain('at_1');
  });
});

describe('handleCallback', () => {
  it('delivers the code to a registered redirect URI', async () => {
    const { callback, table } = await authorized({
      redirectUri: 'cosmospay://auth/cb',
    });
    const url = new URL(callback.redirectTo!);

    expect(url.protocol).toBe('cosmospay:');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe(callback.state);
    // The row keeps the hash, never the code itself.
    expect(table.rows[0].codeHash).toBe(
      hashCode(url.searchParams.get('code')!),
    );
    expect(table.rows[0].codeHash).not.toBe(url.searchParams.get('code'));
  });

  it('mints nothing for a poll-mode handshake — its code comes from the poll', async () => {
    const { callback, table } = await authorized();
    expect(callback.redirectTo).toBeNull();
    expect(callback.outcome).toBe('authorized');
    expect(table.rows[0].status).toBe('AUTHORIZED');
    expect(table.rows[0].codeHash).toBeNull();
  });

  it('does not mint a second code when the callback is replayed', async () => {
    const ctx = await authorized({ redirectUri: 'cosmospay://auth/cb' });
    const first = ctx.callback.redirectTo!;

    const replay = await ctx.service.handleCallback(ctx.auth.state);
    expect(replay.outcome).toBe('already_handled');
    expect(new URL(replay.redirectTo!).searchParams.get('code')).toBeNull();
    // The first code is still the live one.
    expect(ctx.table.rows[0].codeHash).toBe(hashCode(codeFromRedirect(first)));
  });

  it('expires a handshake whose window has closed', async () => {
    const ctx = await makeServiceWithExpiredHandshake();
    await expect(ctx.service.handleCallback('st_1')).rejects.toThrow(/expired/);
    expect(ctx.table.rows[0].status).toBe('EXPIRED');
  });

  it('404s on an unknown state', async () => {
    const { service } = makeService();
    await expect(service.handleCallback('nope')).rejects.toThrow(/Unknown/);
  });
});

describe('exchange', () => {
  it('redeems a code for a Pollar session and never stores the tokens', async () => {
    const ctx = await authorized({ redirectUri: 'cosmospay://auth/cb' });
    const code = codeFromRedirect(ctx.callback.redirectTo!);
    ctx.pollar.sdk
      .mockResolvedValueOnce({ status: 'READY', user: { ready: true } })
      .mockResolvedValueOnce(LOGIN_CONTENT);

    const session = await ctx.service.exchange(CONSUMER, { code });

    expect(session.access_token).toBe('at_1');
    expect(session.refresh_token).toBe('rt_1');
    expect(session.token_type).toBe('Bearer');
    expect(session.wallet.address).toBe(LOGIN_CONTENT.wallet.address);
    // The wallet is told where to go next, so it never needs this service again.
    expect(session.publishable_key).toBe('pub_testnet_x');
    expect(session.api_base_url).toBe('https://sdk.api.pollar.xyz/v2');

    const row = ctx.table.rows[0];
    expect(row.status).toBe('CONSUMED');
    expect(row.codeHash).toBeNull();
    expect(JSON.stringify(row)).not.toContain('at_1');
    expect(JSON.stringify(row)).not.toContain('rt_1');
    expect(JSON.stringify(row)).not.toContain('ada@example.com');
  });

  it('reports DPoP when the handshake bound the tokens to the wallet key', async () => {
    const ctx = makeService();
    ctx.pollar.sdk.mockResolvedValueOnce({ clientSessionId: 'cs_1' });
    const auth = await ctx.service.authorize(CONSUMER, {
      provider: 'google',
      redirect_uri: 'cosmospay://auth/cb',
      dpop_jwk: {
        kty: 'EC',
        crv: 'P-256',
        x: 'x'.repeat(43),
        y: 'y'.repeat(43),
      },
    } as any);
    const callback = await ctx.service.handleCallback(auth.state);
    ctx.pollar.sdk
      .mockResolvedValueOnce({ status: 'READY' })
      .mockResolvedValueOnce(LOGIN_CONTENT);

    const session = await ctx.service.exchange(CONSUMER, {
      code: codeFromRedirect(callback.redirectTo!),
    });

    expect(session.token_type).toBe('DPoP');
    // The wallet's key is what Pollar binds to, not the bridge's.
    expect(ctx.pollar.sdk).toHaveBeenLastCalledWith(
      'POST',
      'testnet',
      '/auth/login',
      expect.objectContaining({
        body: expect.objectContaining({
          dpopJwk: expect.objectContaining({ crv: 'P-256' }),
        }),
      }),
    );
  });

  it('spends the code exactly once', async () => {
    const ctx = await authorized({ redirectUri: 'cosmospay://auth/cb' });
    const code = codeFromRedirect(ctx.callback.redirectTo!);
    ctx.pollar.sdk
      .mockResolvedValueOnce({ status: 'READY' })
      .mockResolvedValueOnce(LOGIN_CONTENT);

    await ctx.service.exchange(CONSUMER, { code });
    await expect(
      ctx.service.exchange(CONSUMER, { code } as any),
    ).rejects.toThrow(/Unknown or already redeemed/);
  });

  it('refuses a code belonging to another consumer', async () => {
    const ctx = await authorized({ redirectUri: 'cosmospay://auth/cb' });
    const code = codeFromRedirect(ctx.callback.redirectTo!);
    (ctx as any).service['consumers'].resolve.mockResolvedValueOnce({
      id: 'other',
    });

    await expect(
      ctx.service.exchange(CONSUMER, { code } as any),
    ).rejects.toThrow(
      // Same message as an unknown code, so the response cannot be used to
      // probe which codes exist.
      /Unknown or already redeemed/,
    );
  });

  it('enforces PKCE when the handshake was opened with a challenge', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const ctx = await authorized({
      redirectUri: 'cosmospay://auth/cb',
      codeChallenge: challenge,
    });
    const code = codeFromRedirect(ctx.callback.redirectTo!);

    await expect(
      ctx.service.exchange(CONSUMER, { code } as any),
    ).rejects.toThrow(/code_verifier is required/);
    await expect(
      ctx.service.exchange(CONSUMER, {
        code,
        code_verifier: 'x'.repeat(43),
      } as any),
    ).rejects.toThrow(/does not match/);

    ctx.pollar.sdk
      .mockResolvedValueOnce({ status: 'READY' })
      .mockResolvedValueOnce(LOGIN_CONTENT);
    await expect(
      ctx.service.exchange(CONSUMER, { code, code_verifier: verifier } as any),
    ).resolves.toMatchObject({ access_token: 'at_1' });
  });

  it('rejects a verifier for a handshake that never had a challenge', async () => {
    const ctx = await authorized({ redirectUri: 'cosmospay://auth/cb' });
    const code = codeFromRedirect(ctx.callback.redirectTo!);
    await expect(
      ctx.service.exchange(CONSUMER, {
        code,
        code_verifier: 'x'.repeat(43),
      } as any),
    ).rejects.toThrow(/not accepted/);
  });

  it('leaves the code redeemable when Pollar is still working', async () => {
    const ctx = await authorized({ redirectUri: 'cosmospay://auth/cb' });
    const code = codeFromRedirect(ctx.callback.redirectTo!);
    ctx.pollar.sdk.mockResolvedValue({ status: 'PENDING' });

    await expect(
      ctx.service.exchange(CONSUMER, { code } as any),
    ).rejects.toThrow(/has not finished this login yet/);
    // Back to AUTHORIZED with its hash intact: a slow Pollar must not cost the
    // user another trip through the consent screen.
    expect(ctx.table.rows[0].status).toBe('AUTHORIZED');
    expect(ctx.table.rows[0].codeHash).toBe(hashCode(code));
  });

  it('kills the handshake when Pollar says the session is gone for good', async () => {
    const ctx = await authorized({ redirectUri: 'cosmospay://auth/cb' });
    const code = codeFromRedirect(ctx.callback.redirectTo!);
    ctx.pollar.sdk.mockRejectedValue(
      new PollarApiError(410, 'EXPIRED_CLIENT_ID', 'gone'),
    );

    await expect(
      ctx.service.exchange(CONSUMER, { code } as any),
    ).rejects.toThrow(/Pollar rejected/);
    expect(ctx.table.rows[0].status).toBe('FAILED');
    expect(ctx.table.rows[0].codeHash).toBeNull();
    expect(ctx.table.rows[0].errorCode).toBe('EXPIRED_CLIENT_ID');
  });
});

describe('status (poll flow)', () => {
  it('issues a redeemable code once the user has come back', async () => {
    const ctx = await authorized();
    const polled = await ctx.service.status(CONSUMER, ctx.auth.state);

    expect(polled.status).toBe('authorized');
    expect(polled.code).toBeTruthy();
    expect(ctx.table.rows[0].codeHash).toBe(hashCode(polled.code!));

    ctx.pollar.sdk
      .mockResolvedValueOnce({ status: 'READY' })
      .mockResolvedValueOnce(LOGIN_CONTENT);
    await expect(
      ctx.service.exchange(CONSUMER, { code: polled.code } as any),
    ).resolves.toMatchObject({ access_token: 'at_1' });
  });

  it('retires the previous code on every poll', async () => {
    const ctx = await authorized();
    const first = await ctx.service.status(CONSUMER, ctx.auth.state);
    const second = await ctx.service.status(CONSUMER, ctx.auth.state);

    expect(second.code).not.toBe(first.code);
    await expect(
      ctx.service.exchange(CONSUMER, { code: first.code } as any),
    ).rejects.toThrow(/Unknown or already redeemed/);
  });

  it('never hands a code to a redirect-mode handshake', async () => {
    const ctx = await authorized({ redirectUri: 'cosmospay://auth/cb' });
    const polled = await ctx.service.status(CONSUMER, ctx.auth.state);

    expect(polled.status).toBe('authorized');
    expect(polled.code).toBeUndefined();
    // The code already delivered by redirect is untouched.
    expect(ctx.table.rows[0].codeHash).toBe(
      hashCode(codeFromRedirect(ctx.callback.redirectTo!)),
    );
  });

  it('reports status only while the user is still at the provider', async () => {
    const ctx = makeService();
    ctx.pollar.sdk.mockResolvedValueOnce({ clientSessionId: 'cs_1' });
    const auth = await ctx.service.authorize(CONSUMER, {
      provider: 'google',
    } as any);

    const polled = await ctx.service.status(CONSUMER, auth.state);
    expect(polled).toMatchObject({ status: 'pending' });
    expect(polled.code).toBeUndefined();
  });

  it("hides another consumer's handshake behind a 404", async () => {
    const ctx = await authorized();
    (ctx as any).service['consumers'].resolve.mockResolvedValueOnce({
      id: 'other',
    });
    await expect(ctx.service.status(CONSUMER, ctx.auth.state)).rejects.toThrow(
      /Unknown/,
    );
  });
});

describe('refresh / logout', () => {
  it('sends the refresh token in the body and no access token', async () => {
    const { service, pollar } = makeService();
    pollar.sdk.mockResolvedValue({
      token: { accessToken: 'at_2', refreshToken: 'rt_2', expiresAt: 1 },
    });

    const pair = await service.refresh(CONSUMER, {
      refresh_token: 'rt_1',
    });

    expect(pair).toEqual({
      access_token: 'at_2',
      refresh_token: 'rt_2',
      token_type: 'Bearer',
      expires_at: 1,
    });
    // Pollar requires the refresh call to carry NO access token — the refresh
    // token is the credential, and sending both is what it rejects.
    const [, , path, opts] = pollar.sdk.mock.calls[0];
    expect(path).toBe('/auth/refresh');
    expect(opts.accessToken).toBeUndefined();
    expect(opts.body).toEqual({ refreshToken: 'rt_1' });
  });

  it('revokes with the access token attached', async () => {
    const { service, pollar } = makeService();
    pollar.sdk.mockResolvedValue({ revoked: 3 });

    const result = await service.logout(CONSUMER, {
      access_token: 'at_1',
      everywhere: true,
    });

    expect(result).toEqual({ revoked: 3 });
    const [, , path, opts] = pollar.sdk.mock.calls[0];
    expect(path).toBe('/auth/logout');
    expect(opts.accessToken).toBe('at_1');
    expect(opts.body).toEqual({ everywhere: true });
  });
});

/** A handshake whose window closed while the user was at the provider. */
async function makeServiceWithExpiredHandshake() {
  const ctx = makeService();
  await ctx.table.create({
    data: {
      consumerId: 'c1',
      state: 'st_1',
      provider: 'google',
      network: 'testnet',
      clientSessionId: 'cs_1',
      expiresAt: new Date(Date.now() - 1),
    },
  });
  return ctx;
}
