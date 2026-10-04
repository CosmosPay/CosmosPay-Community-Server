import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { JupiterClient } from '@/jupiter/jupiter.client';
import { KuruClient } from '@/kuru/kuru.client';

function config(kuruKey = '', jupiterKey = '') {
  const cfg = {
    kuru: { baseUrl: 'https://kuru.example', apiKey: kuruKey, timeoutMs: 5000 },
    jupiter: {
      baseUrl: 'https://jup.example/swap/v1',
      apiKey: jupiterKey,
      timeoutMs: 5000,
    },
  };
  return { get: () => cfg } as unknown as ConfigService<any, true>;
}

type Call = { url: string; init: RequestInit | undefined };

function mockFetch(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  jest
    .spyOn(global, 'fetch')
    .mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const call = { url, init };
      calls.push(call);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(answer(call))),
      } as Response);
    });
  return calls;
}

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('expected a rejection');
}

afterEach(() => jest.restoreAllMocks());

const QUOTE_PARAMS = {
  userAddress: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D',
  tokenIn: '0x0000000000000000000000000000000000000000',
  tokenOut: '0x754704bc059f8c67012fed69bc8a327a5aafb603',
  amount: '10000000000000000000',
  slippageBps: 50,
  referrerAddress: '0x62ee1b8d1efdf8f73c78db87b888406b194e266a',
  referrerFeeBps: 50,
};

describe('KuruClient', () => {
  it('without a key, takes a JWT for the user once and reuses it', async () => {
    const calls = mockFetch(({ url }) =>
      url.endsWith('/api/generate-token')
        ? { token: 'jwt-1', expires_at: Math.floor(Date.now() / 1000) + 3600 }
        : {
            status: 'success',
            output: '286804',
            minOut: '285369',
            transaction: { to: '0xb3e6', calldata: 'ce1e', value: '1' },
          },
    );
    const client = new KuruClient(config());

    await client.quote(QUOTE_PARAMS);
    await client.quote(QUOTE_PARAMS);

    expect(calls.filter((c) => c.url.endsWith('/generate-token'))).toHaveLength(
      1,
    );
    const quote = calls.find((c) => c.url.endsWith('/api/quote'))!;
    expect((quote.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer jwt-1',
    );
    expect(JSON.parse(quote.init?.body as string)).toMatchObject({
      referrerAddress: QUOTE_PARAMS.referrerAddress,
      referrerFeeBps: 50,
      slippageTolerance: 50,
    });
  });

  it('with a key, sends X-API-Key and never asks for a JWT', async () => {
    const calls = mockFetch(() => ({
      status: 'success',
      output: '1',
      minOut: '1',
      transaction: { to: '0xb3e6', calldata: '', value: '0' },
    }));
    await new KuruClient(config('kuru-key')).quote(QUOTE_PARAMS);
    expect(calls).toHaveLength(1);
    expect(
      (calls[0].init?.headers as Record<string, string>)['x-api-key'],
    ).toBe('kuru-key');
  });

  it('reads a 200 carrying an error as the refusal it is', async () => {
    mockFetch(() => ({
      error: 'calculation_failed',
      message: 'no candidate paths available between tokens',
    }));
    const err = await rejection(
      new KuruClient(config('k')).quote(QUOTE_PARAMS),
    );
    expect(err.getStatus()).toBe(400);
    expect(err.code).toBe(ApiErrorCode.ProviderError);
    expect(err.message).toContain('no candidate paths');
  });
});

describe('JupiterClient', () => {
  it('asks for an ExactIn quote with the platform fee', async () => {
    const calls = mockFetch(() => ({ outAmount: '1' }));
    await new JupiterClient(config()).quote({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: '100000000',
      slippageBps: 50,
      platformFeeBps: 50,
    });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/swap/v1/quote');
    expect(url.searchParams.get('platformFeeBps')).toBe('50');
    expect(url.searchParams.get('swapMode')).toBe('ExactIn');
  });

  it('refuses a transaction Jupiter simulated as failing, rather than hand it out', async () => {
    mockFetch(() => ({
      swapTransaction: 'AAAA',
      lastValidBlockHeight: 1,
      simulationError: {
        errorCode: 'TRANSACTION_ERROR',
        error: 'insufficient lamports',
      },
    }));
    const err = await rejection(
      new JupiterClient(config()).swapTransaction({
        quote: {} as never,
        userPublicKey: '13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK',
        feeAccount: null,
      }),
    );
    expect(err.code).toBe(ApiErrorCode.ProviderError);
    expect(err.message).toContain('insufficient lamports');
  });
});
