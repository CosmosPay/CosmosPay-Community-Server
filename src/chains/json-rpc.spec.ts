import { HttpStatus } from '@nestjs/common';
import { callJsonRpc, JsonRpcError } from '@/chains/json-rpc';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';

const target = {
  provider: 'Solana',
  url: 'https://rpc.example',
  timeoutMs: 1000,
};

function respond(status: number, body: string) {
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response(body, { status }));
}

const errorOf = (p: Promise<unknown>) =>
  p.then(() => null).catch((e: unknown) => e);

describe('callJsonRpc', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the result, and sends a JSON-RPC 2.0 body', async () => {
    respond(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x8f' }));
    await expect(callJsonRpc(target, 'eth_chainId', [])).resolves.toBe('0x8f');
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({
      jsonrpc: '2.0',
      method: 'eth_chainId',
      params: [],
    });
    expect(init.redirect).toBe('error');
  });

  it('hands a JSON-RPC error object to the caller to interpret', async () => {
    respond(
      200,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32602, message: 'bad' },
      }),
    );
    const err = await errorOf(callJsonRpc(target, 'getTransaction', []));
    expect(err).toBeInstanceOf(JsonRpcError);
    expect((err as JsonRpcError).code).toBe(-32602);
  });

  it.each([429, 500, 503])(
    'answers HTTP %i as 503 provider_unavailable',
    async (status) => {
      respond(status, 'down');
      const err = (await errorOf(callJsonRpc(target, 'm', []))) as ApiError;
      expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(err.code).toBe(ApiErrorCode.ProviderUnavailable);
    },
  );

  it('answers a body that is not JSON as 502', async () => {
    respond(200, '<html>');
    const err = (await errorOf(callJsonRpc(target, 'm', []))) as ApiError;
    expect(err.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
  });

  it('answers a timeout as 504 and a dead socket as 503', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(timeout);
    let err = (await errorOf(callJsonRpc(target, 'm', []))) as ApiError;
    expect(err.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);

    jest
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    err = (await errorOf(callJsonRpc(target, 'm', []))) as ApiError;
    expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(err.message).toMatch(/Solana RPC/);
  });
});
