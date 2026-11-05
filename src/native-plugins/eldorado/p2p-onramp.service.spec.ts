import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { UpstreamNotFound } from '@/common/upstream-http';
import type { EldoradoClient } from '@/native-plugins/eldorado/eldorado.client';
import { P2pOnrampService } from '@/native-plugins/eldorado/p2p-onramp.service';

const ADDRESS_LOWER = '0x52908400098527886e0f7030069857d2e4169ee7';
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';

const key = (environment: 'prod' | 'dev'): GatewayConsumer => ({
  username: 'cosmos_u1',
  credentialId: null,
  environment,
  role: 'user',
  permissions: ['onramp:read', 'onramp:write'],
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
    integratorIds: jest.fn(() => ids),
  };
  const prisma = {
    onrampP2pSession: {
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
  const service = new P2pOnrampService(
    config as never,
    prisma as never,
    consumers as never,
    client as unknown as EldoradoClient,
  );
  return { service, client, prisma, consumers };
}

describe('P2pOnrampService', () => {
  it('reads the market on the key network and serves it from memory', async () => {
    const { service, client } = setup();

    const market = await service.market(key('prod'));
    await service.market(key('prod'));

    expect(market.chainId).toBe(42161);
    expect(market.currencies.map((c) => c.id)).toEqual(['ARS']);
    expect(client.currencies).toHaveBeenCalledTimes(1);
    expect(client.currencies).toHaveBeenCalledWith('public');
  });

  it('keeps the sandbox market apart from mainnet', async () => {
    const { service, client } = setup();

    await service.market(key('prod'));
    const sandbox = await service.market(key('dev'));

    expect(sandbox.chainId).toBe(421614);
    expect(client.currencies).toHaveBeenNthCalledWith(2, 'testnet');
  });

  it('answers a 502 when the marketplace answers a market it cannot read', async () => {
    const { service, client } = setup();
    client.prices.mockResolvedValue({});

    await expect(service.market(key('prod'))).rejects.toMatchObject({
      code: ApiErrorCode.ProviderError,
    });
  });

  it('turns a 404 from the marketplace into a 502', async () => {
    const { service, client } = setup();
    client.currencies.mockRejectedValue(
      new UpstreamNotFound('P2P marketplace'),
    );

    const error = await service.market(key('prod')).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).getStatus()).toBe(502);
  });

  it('opens a session with the recipient fixed, on the key network', async () => {
    const { service, prisma } = setup();

    const session = await service.createSession(key('prod'), ORDER);

    const data = prisma.onrampP2pSession.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      consumerId: 'c_local',
      network: 'public',
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

    const session = await service.createSession(key('prod'), ORDER);

    expect(new URL(session.widgetUrl).searchParams.get('clientId')).toBe('c-1');
  });

  it('refuses an order the market does not take, before storing anything', async () => {
    const { service, prisma } = setup();

    await expect(
      service.createSession(key('prod'), { ...ORDER, amount: '100' }),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationFailed,
    });
    // The sandbox delivers only its test USDT.
    await expect(
      service.createSession(key('dev'), ORDER),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ValidationFailed,
    });
    expect(prisma.onrampP2pSession.create).not.toHaveBeenCalled();
  });

  it('quotes through the marketplace with the token contract and the checksummed recipient', async () => {
    const { service, client } = setup({ clientId: 'c-1', referralId: 'r-1' });

    const quote = await service.quote(key('prod'), ORDER);

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

  it('answers a 502 for a quote it cannot read', async () => {
    const { service, client } = setup({ clientId: 'c-1', referralId: 'r-1' });
    client.buyQuote.mockResolvedValue({ amountIn: '50000' });

    await expect(service.quote(key('prod'), ORDER)).rejects.toMatchObject({
      code: ApiErrorCode.ProviderError,
    });
  });

  it('lists and reads only the consumer’s sessions on the key network', async () => {
    const { service, prisma } = setup();

    await service.findAll(key('dev'), { take: 100, skip: 0 });
    await expect(
      service.findOne(key('dev'), 'clz_other'),
    ).rejects.toMatchObject({
      code: ApiErrorCode.NotFound,
    });

    expect(prisma.onrampP2pSession.findMany.mock.calls[0][0].where).toEqual({
      consumerId: 'c_local',
      network: 'testnet',
    });
    expect(prisma.onrampP2pSession.findFirst.mock.calls[0][0].where).toEqual({
      id: 'clz_other',
      consumerId: 'c_local',
      network: 'testnet',
    });
  });
});
