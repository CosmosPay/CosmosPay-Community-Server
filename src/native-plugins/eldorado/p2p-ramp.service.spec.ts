import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { UpstreamNotFound } from '@/common/upstream-http';
import type { EldoradoClient } from '@/native-plugins/eldorado/eldorado.client';
import { P2pRampService } from '@/native-plugins/eldorado/p2p-ramp.service';

const ADDRESS_LOWER = '0x52908400098527886e0f7030069857d2e4169ee7';
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';

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

const ORDER = {
  currency: 'ARS',
  paymentMethod: 'bank_tx_ar',
  token: 'USDC',
  amount: '50000',
  address: ADDRESS_LOWER,
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
      BUY: { ARS: { price: '1677.89', limits: { in: { min: '8389.45' } } } },
      SELL: { ARS: { price: '1625.11', limits: { in: { min: '5' } } } },
    }),
    buyQuote: jest.fn().mockResolvedValue({
      quoteId: 'q-1',
      amountIn: '50000',
      amountOut: '29.10',
      minAmountOut: '28.52',
      exchangeRate: '1718.2',
      expiresAt: '2026-11-05T18:05:00.000Z',
      fee: { amountInToken: '0.69', amountInFiat: '1185.6' },
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
    get: jest.fn(() => ({ network: 'testnet' })),
  } as unknown as ConfigService;
  const service = new P2pRampService(
    config as never,
    prisma as never,
    consumers as never,
    client as unknown as EldoradoClient,
  );
  return { service, client, prisma, consumers };
}

const SALE = { ...ORDER, token: 'USDT', amount: '50' };

describe('P2pRampService', () => {
  it('reads the market on the key network and serves it from memory', async () => {
    const { service, client } = setup();

    const market = await service.market(key('prod'), 'buy');
    await service.market(key('prod'), 'buy');

    expect(market.chainId).toBe(42161);
    expect(market.currencies.map((c) => c.id)).toEqual(['ARS']);
    expect(client.currencies).toHaveBeenCalledTimes(1);
    expect(client.currencies).toHaveBeenCalledWith('public');
  });

  it('serves both sides from one read, each with its own prices', async () => {
    const { service, client } = setup();

    const buy = await service.market(key('prod'), 'buy');
    const sell = await service.market(key('prod'), 'sell');

    expect(buy.currencies[0]).toMatchObject({ price: '1677.89' });
    expect(sell.currencies[0]).toMatchObject({
      price: '1625.11',
      minAmount: '5',
    });
    expect(client.prices).toHaveBeenCalledTimes(1);
  });

  it('keeps buying when the marketplace sends no sell side', async () => {
    const { service, client } = setup();
    client.prices.mockResolvedValue({
      BUY: { ARS: { price: '1677.89', limits: { in: { min: '8389.45' } } } },
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

    expect(sandbox.chainId).toBe(421614);
    expect(client.currencies).toHaveBeenNthCalledWith(2, 'testnet');
  });

  it('answers a 502 when the marketplace answers a market it cannot read', async () => {
    const { service, client } = setup();
    client.prices.mockResolvedValue({});

    await expect(service.market(key('prod'), 'buy')).rejects.toMatchObject({
      code: ApiErrorCode.ProviderError,
    });
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

  it('opens a session with the recipient fixed, on the key network', async () => {
    const { service, prisma } = setup();

    const session = await service.createSession(key('prod'), 'buy', ORDER);

    const data = prisma.p2pRampSession.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      consumerId: 'c_local',
      network: 'public',
      side: 'buy',
      currency: 'ARS',
      token: 'USDC',
      tokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      chainId: 42161,
      // Stored and sent EIP-55, however the caller spelled it.
      address: ADDRESS,
      estimatedAmountOut: '29.79',
    });
    expect(data.reference).toMatch(/^cp-[0-9a-f-]{36}$/);
    const url = new URL(session.widgetUrl);
    expect(url.searchParams.get('address')).toBe(ADDRESS);
    expect(url.searchParams.get('externalReferenceId')).toBe(data.reference);
    expect(url.searchParams.get('clientId')).toBeNull();
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
      token: 'USDT',
      address: ADDRESS,
      // 50 * 1625.11
      estimatedAmountOut: '81255.50',
    });
    const url = new URL(session.widgetUrl);
    expect(url.searchParams.get('operation')).toBe('SELL');
    expect(url.searchParams.get('address')).toBeNull();
  });

  it('refuses a sale below the minimum in the stablecoin', async () => {
    const { service, prisma } = setup();

    await expect(
      service.createSession(key('prod'), 'sell', { ...SALE, amount: '4' }),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationFailed,
      message: 'amount is below the minimum of 5 USDT',
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
    // The sandbox delivers only its test USDT.
    await expect(
      service.createSession(key('dev'), 'buy', ORDER),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationFailed,
    });
    expect(prisma.p2pRampSession.create).not.toHaveBeenCalled();
  });

  it('quotes through the marketplace with the token contract and the checksummed recipient', async () => {
    const { service, client } = setup({ clientId: 'c-1', referralId: 'r-1' });

    const quote = await service.quote(key('prod'), 'buy', ORDER);

    expect(client.buyQuote).toHaveBeenCalledWith('public', {
      addressTo: ADDRESS,
      token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      chainId: '42161',
      fiatCurrencyId: 'ARS',
      paymentMethodId: 'bank_tx_ar',
      amount: '50000',
      fixedAmountSide: 'IN',
    });
    expect(quote).toEqual({
      quoteId: 'q-1',
      currency: 'ARS',
      token: 'USDC',
      chainId: 42161,
      amountIn: '50000',
      amountOut: '29.10',
      minAmountOut: '28.52',
      exchangeRate: '1718.2',
      fee: { amountInToken: '0.69', amountInFiat: '1185.6' },
      expiresAt: '2026-11-05T18:05:00.000Z',
    });
  });

  it('quotes a sale from the account it is sent from', async () => {
    const { service, client } = setup({ clientId: 'c-1', referralId: 'r-1' });

    const quote = await service.quote(key('prod'), 'sell', SALE);

    expect(client.sellQuote).toHaveBeenCalledWith('public', {
      addressFrom: ADDRESS,
      token: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      chainId: '42161',
      fiatCurrencyId: 'ARS',
      paymentMethodId: 'bank_tx_ar',
      amount: '50',
      fixedAmountSide: 'IN',
    });
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
});
