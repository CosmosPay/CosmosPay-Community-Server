import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { PublicRecordTokens } from '@/common/public-record-token';
import { UpstreamNotFound } from '@/common/upstream-http';
import type { EldoradoClient } from '@/native-plugins/eldorado/eldorado.client';
import { NATIVE_TOKEN_ADDRESS } from '@/native-plugins/eldorado/eldorado.constants';
import { P2pRampService } from '@/native-plugins/eldorado/p2p-ramp.service';

const ADDRESS_LOWER = '0x52908400098527886e0f7030069857d2e4169ee7';
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const USDT0 = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const SANDBOX_USDT = '0x25f5D414F85b7f4668ADe4E557ef234023208771';

const key = (environment: 'prod' | 'dev'): GatewayConsumer => ({
  username: 'cosmos_u1',
  credentialId: null,
  environment,
  role: 'user',
  permissions: ['onramp:read', 'onramp:write', 'offramp:read', 'offramp:write'],
  organizationId: null,
  plan: null,
  planSwapFeeBps: null,
});

/** The shared public key every wallet without an account calls with. */
const publicKey = (environment: 'prod' | 'dev'): GatewayConsumer => ({
  ...key(environment),
  username: 'cosmos_public',
  role: 'public',
});

const ORDER = {
  currency: 'ARS',
  paymentMethod: 'bank_tx_ar',
  chainId: 42161,
  token: USDT0.toLowerCase(),
  amount: '50000',
  address: ADDRESS_LOWER,
};
const SALE = { ...ORDER, amount: '50' };

/** Token lists per chain, in the marketplace's shape (trimmed copies of 2026-11-05's). */
const TOKENS: Record<string, unknown> = {
  '42161': {
    tokens: [
      {
        address: NATIVE_TOKEN_ADDRESS,
        symbol: 'ETH',
        decimals: 18,
        logo: 'https://example.invalid/eth.png',
        priceUSD: '2241.32',
      },
      {
        address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        symbol: 'USDC',
        decimals: 6,
        priceUSD: '1',
      },
      { address: USDT0, symbol: 'USDT0', decimals: 6, priceUSD: '1' },
      {
        address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
        symbol: 'ARB',
        decimals: 18,
      },
    ],
  },
  '137': {
    tokens: [
      {
        address: NATIVE_TOKEN_ADDRESS,
        symbol: 'POL',
        decimals: 18,
        priceUSD: '0.1',
      },
    ],
  },
  '81457': { tokens: [] },
  '421614': {
    tokens: [{ address: SANDBOX_USDT, symbol: 'USDT', decimals: 18 }],
  },
};

function setup(ids: { clientId: string; referralId: string } | null = null) {
  const client = {
    currencies: jest.fn().mockResolvedValue({
      currencies: [
        { id: 'ARS', type: 'FIAT', description: { en: 'Argentine Pesos' } },
      ],
    }),
    paymentMethods: jest.fn().mockResolvedValue({
      paymentMethods: [
        { id: 'bank_tx_ar', name: 'Bank Transfer (ARS)', currency: 'ARS' },
      ],
    }),
    prices: jest.fn().mockResolvedValue({
      BUY: { ARS: { price: '1600', limits: { in: { min: '8000' } } } },
      SELL: { ARS: { price: '1625.11', limits: { in: { min: '5' } } } },
    }),
    chains: jest.fn((network: string) =>
      Promise.resolve({
        chains: network === 'public' ? ['137', '42161', '81457'] : ['421614'],
      }),
    ),
    tokens: jest.fn((_network: string, chainId: number) =>
      Promise.resolve(TOKENS[String(chainId)]),
    ),
    buyQuote: jest.fn().mockResolvedValue({
      quoteId: 'q-1',
      amountIn: '50000',
      amountOut: '30.50',
      minAmountOut: '29.89',
      exchangeRate: '1639.3',
      expiresAt: '2026-11-05T18:05:00.000Z',
      fee: { amountInToken: '0.62', amountInFiat: '1016.4' },
    }),
    sellQuote: jest.fn().mockResolvedValue({
      quoteId: 'q-2',
      amountIn: '50',
      amountOut: '79630.39',
      minAmountOut: '78037.78',
      exchangeRate: '1592.6078',
      expiresAt: '2026-11-05T18:05:00.000Z',
      fee: { amountInToken: '1', amountInFiat: '1625.11' },
    }),
    integratorIds: jest.fn(() => ids),
  };
  const prisma = {
    p2pRampSession: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'clz_s1', createdAt: new Date(0), ...data }),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const consumers = {
    resolve: jest.fn().mockResolvedValue({ id: 'c_local' }),
    resolveId: jest.fn().mockResolvedValue('c_local'),
  };
  const config = {
    get: jest.fn((name: string) =>
      name === 'apisix'
        ? {
            publicConsumer: 'cosmos_public',
            gatewaySecret: 'topsecret-topsecret-topsecret-topsecret',
          }
        : { network: 'testnet' },
    ),
  } as unknown as ConfigService;
  const recordTokens = new PublicRecordTokens(config as never);
  const service = new P2pRampService(
    config as never,
    prisma as never,
    consumers as never,
    client as unknown as EldoradoClient,
    recordTokens,
  );
  return { service, client, prisma, consumers, recordTokens };
}

describe('P2pRampService', () => {
  it('reads the market on the key network and serves it from memory', async () => {
    const { service, client } = setup();

    const market = await service.market(key('prod'), 'buy');
    await service.market(key('prod'), 'buy');

    expect(market.currencies.map((c) => c.id)).toEqual(['ARS']);
    expect(market.defaultToken).toEqual({
      chainId: 42161,
      address: USDT0,
      symbol: 'USDT0',
      decimals: 6,
    });
    expect(client.currencies).toHaveBeenCalledTimes(1);
    expect(client.currencies).toHaveBeenCalledWith('public');
  });

  it('offers every chain with tokens, the default first, and leaves an empty one out', async () => {
    const { service } = setup();

    const market = await service.market(key('prod'), 'buy');

    expect(market.networks).toEqual([
      { chainId: 42161, name: 'Arbitrum', tokenCount: 4 },
      { chainId: 137, name: 'Polygon', tokenCount: 1 },
    ]);
  });

  it('leaves out a chain whose token list fails, and asks for it again on the next read', async () => {
    const { service, client } = setup();
    client.tokens.mockImplementation((_network: string, chainId: number) =>
      chainId === 137
        ? Promise.reject(new Error('500 from the marketplace'))
        : Promise.resolve(TOKENS[String(chainId)]),
    );
    jest.useFakeTimers({ now: Date.now() });

    try {
      const first = await service.market(key('prod'), 'buy');
      expect(first.networks.map((n) => n.chainId)).toEqual([42161]);

      // Past the market's minute, inside the token lists' hour.
      jest.setSystemTime(Date.now() + 61_000);
      client.tokens.mockImplementation((_network: string, chainId: number) =>
        Promise.resolve(TOKENS[String(chainId)]),
      );
      const second = await service.market(key('prod'), 'buy');

      expect(second.networks.map((n) => n.chainId)).toEqual([42161, 137]);
      // Arbitrum's list was kept for the hour; Polygon's and Blast's were asked again.
      const asked = client.tokens.mock.calls.map((c) => c[1]);
      expect(asked.filter((id) => id === 42161)).toHaveLength(1);
      expect(asked.filter((id) => id === 137)).toHaveLength(2);
      expect(asked.filter((id) => id === 81457)).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('answers a 502 when no token list can be read, or the chain list is empty', async () => {
    const { service, client } = setup();
    client.tokens.mockRejectedValue(new Error('down'));

    await expect(service.market(key('prod'), 'buy')).rejects.toMatchObject({
      code: ApiErrorCode.ProviderError,
    });

    const other = setup();
    other.client.chains.mockResolvedValue({ chains: [] });
    await expect(
      other.service.market(key('prod'), 'buy'),
    ).rejects.toMatchObject({ code: ApiErrorCode.ProviderError });
  });

  it('serves both sides from one read, each with its own prices', async () => {
    const { service, client } = setup();

    const buy = await service.market(key('prod'), 'buy');
    const sell = await service.market(key('prod'), 'sell');

    expect(buy.currencies[0]).toMatchObject({ price: '1600' });
    expect(sell.currencies[0]).toMatchObject({
      price: '1625.11',
      minAmount: '5',
    });
    expect(client.prices).toHaveBeenCalledTimes(1);
  });

  it('keeps buying when the marketplace sends no sell side', async () => {
    const { service, client } = setup();
    client.prices.mockResolvedValue({
      BUY: { ARS: { price: '1600', limits: { in: { min: '8000' } } } },
    });

    expect((await service.market(key('prod'), 'buy')).currencies).toHaveLength(
      1,
    );
    expect((await service.market(key('prod'), 'sell')).currencies).toEqual([]);
  });

  it('keeps the sandbox market apart from mainnet', async () => {
    const { service, client } = setup();

    await service.market(key('prod'), 'buy');
    const sandbox = await service.market(key('dev'), 'buy');

    expect(sandbox.networks).toEqual([
      { chainId: 421614, name: 'Arbitrum Sepolia', tokenCount: 1 },
    ]);
    expect(sandbox.defaultToken.address).toBe(SANDBOX_USDT);
    expect(client.currencies).toHaveBeenNthCalledWith(2, 'testnet');
  });

  it('turns a 404 from the marketplace into a 502', async () => {
    const { service, client } = setup();
    client.currencies.mockRejectedValue(
      new UpstreamNotFound('P2P marketplace'),
    );

    const error = await service
      .market(key('prod'), 'buy')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).getStatus()).toBe(502);
  });

  describe('tokens', () => {
    it('pages one chain’s tokens, its main assets first, each with its listing’s logo', async () => {
      const { service } = setup();

      const page = await service.tokens(key('prod'), {
        chainId: 42161,
        take: 2,
        skip: 0,
      });

      expect(page).toEqual({
        data: [
          {
            chainId: 42161,
            address: NATIVE_TOKEN_ADDRESS,
            symbol: 'ETH',
            decimals: 18,
            priceUsd: '2241.32',
            logoUrl: 'https://example.invalid/eth.png',
            main: true,
          },
          {
            chainId: 42161,
            address: USDT0,
            symbol: 'USDT0',
            decimals: 6,
            priceUsd: '1',
            logoUrl: null,
            main: true,
          },
        ],
        total: 4,
        take: 2,
        skip: 0,
      });
    });

    it('searches by symbol or address', async () => {
      const { service } = setup();

      const bySymbol = await service.tokens(key('prod'), {
        chainId: 42161,
        q: 'eth',
        take: 100,
        skip: 0,
      });
      const byAddress = await service.tokens(key('prod'), {
        chainId: 42161,
        q: NATIVE_TOKEN_ADDRESS,
        take: 100,
        skip: 0,
      });

      expect(bySymbol.data.map((t) => t.symbol)).toEqual(['ETH']);
      expect(byAddress.data.map((t) => t.symbol)).toEqual(['ETH']);
    });

    it('refuses a chain the market does not offer, an empty one included', async () => {
      const { service } = setup();

      await expect(
        service.tokens(key('prod'), { chainId: 81457, take: 100, skip: 0 }),
      ).rejects.toMatchObject({
        code: ApiErrorCode.ValidationFailed,
        message: 'chainId 81457 is not offered (offered: 42161, 137)',
      });
    });
  });

  it('opens a session with the recipient fixed, on the key network', async () => {
    const { service, prisma } = setup();

    const session = await service.createSession(key('prod'), 'buy', ORDER);

    const data = prisma.p2pRampSession.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      consumerId: 'c_local',
      network: 'public',
      side: 'buy',
      currency: 'ARS',
      token: 'USDT0',
      // Stored EIP-55, however the caller spelled it.
      tokenAddress: USDT0,
      chainId: 42161,
      address: ADDRESS,
      // 50000 / 1600 / 1
      estimatedAmountOut: '31.25',
    });
    expect(data.reference).toMatch(/^cp-[0-9a-f-]{36}$/);
    const url = new URL(session.widgetUrl);
    expect(url.searchParams.get('address')).toBe(ADDRESS);
    expect(url.searchParams.get('token')).toBe(USDT0);
    expect(url.searchParams.get('chain')).toBe('42161');
    expect(url.searchParams.get('externalReferenceId')).toBe(data.reference);
    expect(url.searchParams.get('clientId')).toBeNull();
  });

  it('buys a token on another chain, and stores no estimate for one with no USD price', async () => {
    const { service, prisma } = setup();

    await service.createSession(key('prod'), 'buy', {
      ...ORDER,
      chainId: 137,
      token: NATIVE_TOKEN_ADDRESS,
    });
    await service.createSession(key('prod'), 'buy', {
      ...ORDER,
      token: '0x912ce59144191c1204e64559fe8253a0e49e6548',
    });

    const [pol, arb] = prisma.p2pRampSession.create.mock.calls.map(
      (c) => c[0].data,
    );
    // 50000 / 1600 / 0.1
    expect(pol).toMatchObject({
      chainId: 137,
      token: 'POL',
      estimatedAmountOut: '312.50',
    });
    expect(arb).toMatchObject({ token: 'ARB', estimatedAmountOut: null });
  });

  it('puts the integrator ids in the widget when configured', async () => {
    const { service } = setup({ clientId: 'c-1', referralId: 'r-1' });

    const session = await service.createSession(key('prod'), 'buy', ORDER);

    expect(new URL(session.widgetUrl).searchParams.get('clientId')).toBe('c-1');
  });

  it('opens a sale without fixing the wallet, estimating the local money', async () => {
    const { service, prisma } = setup();

    const session = await service.createSession(key('prod'), 'sell', SALE);

    const data = prisma.p2pRampSession.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      side: 'sell',
      currency: 'ARS',
      amount: '50',
      token: 'USDT0',
      address: ADDRESS,
      // 50 * 1 * 1625.11
      estimatedAmountOut: '81255.50',
    });
    const url = new URL(session.widgetUrl);
    expect(url.searchParams.get('operation')).toBe('SELL');
    expect(url.searchParams.get('address')).toBeNull();
  });

  it('refuses a sale under the minimum in USD', async () => {
    const { service, prisma } = setup();

    await expect(
      service.createSession(key('prod'), 'sell', { ...SALE, amount: '4' }),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationFailed,
      message: 'amount is below the minimum of 5 USD (about 5.00 USDT0)',
    });
    expect(prisma.p2pRampSession.create).not.toHaveBeenCalled();
  });

  it('refuses an order the market does not take, before storing anything', async () => {
    const { service, prisma } = setup();

    await expect(
      service.createSession(key('prod'), 'buy', { ...ORDER, amount: '100' }),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationFailed,
    });
    // An empty chain is not offered.
    await expect(
      service.createSession(key('prod'), 'buy', { ...ORDER, chainId: 81457 }),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationFailed,
      message: 'chainId 81457 is not offered (offered: 42161, 137)',
    });
    // The sandbox lists only its test USDT on Arbitrum Sepolia.
    await expect(
      service.createSession(key('dev'), 'buy', ORDER),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationFailed,
      message: 'chainId 42161 is not offered (offered: 421614)',
    });
    expect(prisma.p2pRampSession.create).not.toHaveBeenCalled();
  });

  it('quotes through the marketplace with the token contract, its chain and the checksummed recipient', async () => {
    const { service, client } = setup({ clientId: 'c-1', referralId: 'r-1' });

    const quote = await service.quote(key('prod'), 'buy', ORDER);

    expect(client.buyQuote).toHaveBeenCalledWith(
      'public',
      {
        addressTo: ADDRESS,
        token: USDT0,
        chainId: '42161',
        fiatCurrencyId: 'ARS',
        paymentMethodId: 'bank_tx_ar',
        amount: '50000',
        fixedAmountSide: 'IN',
      },
      false,
    );
    expect(quote).toEqual({
      quoteId: 'q-1',
      currency: 'ARS',
      token: 'USDT0',
      tokenAddress: USDT0,
      chainId: 42161,
      amountIn: '50000',
      amountOut: '30.50',
      minAmountOut: '29.89',
      exchangeRate: '1639.3',
      fee: { amountInToken: '0.62', amountInFiat: '1016.4' },
      expiresAt: '2026-11-05T18:05:00.000Z',
    });
  });

  it('quotes a sale from the account it is sent from', async () => {
    const { service, client } = setup({ clientId: 'c-1', referralId: 'r-1' });

    const quote = await service.quote(key('prod'), 'sell', SALE);

    expect(client.sellQuote).toHaveBeenCalledWith(
      'public',
      {
        addressFrom: ADDRESS,
        token: USDT0,
        chainId: '42161',
        fiatCurrencyId: 'ARS',
        paymentMethodId: 'bank_tx_ar',
        amount: '50',
        fixedAmountSide: 'IN',
      },
      false,
    );
    expect(client.buyQuote).not.toHaveBeenCalled();
    expect(quote).toMatchObject({
      quoteId: 'q-2',
      amountIn: '50',
      amountOut: '79630.39',
    });
  });

  it('answers a 502 for a quote it cannot read', async () => {
    const { service, client } = setup({ clientId: 'c-1', referralId: 'r-1' });
    client.buyQuote.mockResolvedValue({ amountIn: '50000' });

    await expect(
      service.quote(key('prod'), 'buy', ORDER),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ProviderError,
    });
  });

  it('lists and reads only the consumer’s sessions of the side, on the key network', async () => {
    const { service, prisma } = setup();

    await service.findAll(key('dev'), 'buy', { take: 100, skip: 0 });
    await expect(
      service.findOne(key('dev'), 'sell', 'clz_other'),
    ).rejects.toMatchObject({
      code: ApiErrorCode.NotFound,
      message: 'P2P off-ramp session not found',
    });

    expect(prisma.p2pRampSession.findMany.mock.calls[0][0].where).toEqual({
      consumerId: 'c_local',
      network: 'testnet',
      side: 'buy',
    });
    expect(prisma.p2pRampSession.findFirst.mock.calls[0][0].where).toEqual({
      id: 'clz_other',
      consumerId: 'c_local',
      network: 'testnet',
      side: 'sell',
    });
  });

  describe('the shared public key', () => {
    it('quotes and opens a session with its own integrator ids, and gets the session token', async () => {
      const { service, client, recordTokens } = setup({
        clientId: 'c-1',
        referralId: 'r-public',
      });

      await service.quote(publicKey('prod'), 'buy', ORDER);
      const session = await service.createSession(
        publicKey('prod'),
        'buy',
        ORDER,
      );

      expect(client.buyQuote.mock.calls[0][2]).toBe(true);
      expect(client.integratorIds).toHaveBeenLastCalledWith(true);
      expect(new URL(session.widgetUrl).searchParams.get('referralId')).toBe(
        'r-public',
      );
      expect(session.publicToken).toEqual(expect.any(String));
      expect(
        recordTokens.admits(
          publicKey('prod'),
          'p2p-ramp-session',
          session.id,
          session.publicToken,
        ),
      ).toBe(true);
    });

    it('gives an account no token and its ordinary ids', async () => {
      const { service, client } = setup({ clientId: 'c-1', referralId: 'r-1' });

      const session = await service.createSession(key('prod'), 'buy', ORDER);

      expect(client.integratorIds).toHaveBeenLastCalledWith(false);
      expect(session).not.toHaveProperty('publicToken');
    });

    it('reads a session back only with its token, refusing before the table is read', async () => {
      const { service, prisma, recordTokens } = setup();
      const session = await service.createSession(
        publicKey('prod'),
        'sell',
        SALE,
      );
      const anotherSessionsToken = recordTokens.issueFor(
        publicKey('prod'),
        'p2p-ramp-session',
        'clz_s2',
      );
      prisma.p2pRampSession.findFirst.mockResolvedValue({ id: session.id });

      for (const token of [undefined, 'not-a-token', anotherSessionsToken]) {
        await expect(
          service.findOne(publicKey('prod'), 'sell', session.id, token),
        ).rejects.toMatchObject({ code: ApiErrorCode.NotFound });
      }
      expect(prisma.p2pRampSession.findFirst).not.toHaveBeenCalled();

      await expect(
        service.findOne(
          publicKey('prod'),
          'sell',
          session.id,
          session.publicToken,
        ),
      ).resolves.toEqual({ id: session.id });
      expect(prisma.p2pRampSession.findFirst.mock.calls[0][0].where).toEqual({
        id: session.id,
        consumerId: 'c_local',
        network: 'public',
        side: 'sell',
      });
    });
  });
});
