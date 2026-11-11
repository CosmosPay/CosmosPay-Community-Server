import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig } from '@/config/configuration';
import { TrustlessWorkClient } from '@/native-plugins/trustless-work/trustless-work.client';

const network = (apiKey: string) => ({
  apiKey,
  baseUrl: 'https://dev.api.trustlesswork.com',
  platformSecret: '',
  resolverSecret: '',
  opsResolver: '',
  deployerContract: '',
  contractWasmHash: '',
});

function client(apiKey = 'tw_test_key') {
  const config = {
    get: jest.fn((): AppConfig['trustlessWork'] => ({
      networks: { testnet: network(apiKey), public: network('') },
      platformFeeBps: 165,
      timeoutMs: 1_000,
      maxFeeStroops: 20_000_000,
    })),
  } as unknown as ConfigService<AppConfig, true>;
  return new TrustlessWorkClient(config);
}

const answer = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

const RELEASE = { contractId: 'CABC', releaseSigner: 'GABC' };

async function refusal(work: Promise<unknown>): Promise<ApiError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('TrustlessWorkClient', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('answers the unsigned envelope, sending the network key as x-api-key', async () => {
    fetchMock.mockReturnValue(
      answer(201, { status: 'SUCCESS', unsignedTransaction: 'AAAA' }),
    );

    await expect(client().releaseFunds('testnet', RELEASE)).resolves.toBe(
      'AAAA',
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://dev.api.trustlesswork.com/escrow/single-release/release-funds',
    );
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(
      'tw_test_key',
    );
    expect(JSON.parse(init.body as string)).toEqual(RELEASE);
  });

  it('is 503 misconfigured, before any call, on a network without a key', async () => {
    const error = await refusal(client().releaseFunds('public', RELEASE));
    expect(error.getStatus()).toBe(503);
    expect(error.code).toBe(ApiErrorCode.Misconfigured);
    expect(error.operatorDetail).toMatch(/TRUSTLESS_WORK_API_KEY_MAINNET/);
    expect(error.message).not.toMatch(/TRUSTLESS/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      400,
      { message: 'amount must be a number' },
      400,
      ApiErrorCode.ProviderError,
    ],
    [401, { message: 'Unauthorized' }, 503, ApiErrorCode.Misconfigured],
    [
      429,
      { message: 'Too Many Requests' },
      503,
      ApiErrorCode.ProviderUnavailable,
    ],
    [
      500,
      { status: 'FAILED', message: 'Escrow not found' },
      502,
      ApiErrorCode.ProviderError,
    ],
    [404, { message: 'Cannot POST' }, 502, ApiErrorCode.ProviderError],
  ])(
    'maps a %s from Trustless Work to %s',
    async (status, body, expected, code) => {
      fetchMock.mockReturnValue(answer(status, body));
      const error = await refusal(client().releaseFunds('testnet', RELEASE));
      expect(error.getStatus()).toBe(expected);
      expect(error.code).toBe(code);
    },
  );

  it('names the variable when Trustless Work refuses the key', async () => {
    fetchMock.mockReturnValue(answer(401, {}));
    const error = await refusal(client().releaseFunds('testnet', RELEASE));
    expect(error.operatorDetail).toMatch(/TRUSTLESS_WORK_API_KEY_TESTNET/);
    expect(error.message).not.toMatch(/TRUSTLESS/i);
  });

  it('is 502 with Trustless Work’s message when a 2xx says FAILED', async () => {
    fetchMock.mockReturnValue(
      answer(201, { status: 'FAILED', message: 'Escrow already released' }),
    );
    const error = await refusal(client().releaseFunds('testnet', RELEASE));
    expect(error.getStatus()).toBe(502);
    expect(error.message).toBe(
      'Trustless Work could not build the transaction: Escrow already released',
    );
  });

  it('is 502 when a build has no envelope in it', async () => {
    fetchMock.mockReturnValue(answer(201, { status: 'SUCCESS' }));
    const error = await refusal(client().releaseFunds('testnet', RELEASE));
    expect(error.message).toBe(
      'Trustless Work returned no transaction to sign.',
    );
  });

  it('is 504 when Trustless Work does not answer in time', async () => {
    fetchMock.mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error('aborted'), { name: 'AbortError' }),
      ),
    );
    const error = await refusal(client().releaseFunds('testnet', RELEASE));
    expect(error.getStatus()).toBe(504);
    expect(error.code).toBe(ApiErrorCode.ProviderUnavailable);
  });

  it('answers a send, FAILED included, as Trustless Work said it', async () => {
    fetchMock.mockReturnValue(
      answer(200, { status: 'FAILED', message: 'tx_bad_seq' }),
    );
    await expect(client().send('testnet', 'AAAA')).resolves.toEqual({
      status: 'FAILED',
      message: 'tx_bad_seq',
    });
  });

  it('reads contracts by id, checked on-chain, and a 404 as none indexed', async () => {
    fetchMock.mockReturnValueOnce(
      answer(200, [{ contractId: 'C1', balance: 10 }]),
    );
    await expect(client().contracts('testnet', ['C1', 'C2'])).resolves.toEqual([
      { contractId: 'C1', balance: 10 },
    ]);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(decodeURIComponent(url)).toBe(
      'https://dev.api.trustlesswork.com/helper/get-escrow-by-contract-ids' +
        '?contractIds[]=C1&contractIds[]=C2&validateOnChain=true',
    );

    fetchMock.mockReturnValueOnce(answer(404, { message: 'Not found' }));
    await expect(client().contracts('testnet', ['C3'])).resolves.toEqual([]);
  });
});
