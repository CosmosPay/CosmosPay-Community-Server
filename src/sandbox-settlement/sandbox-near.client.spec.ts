import { HttpStatus } from '@nestjs/common';
import { ApiError } from '@/common/errors/api-error';
import { SandboxNearClient } from '@/sandbox-settlement/sandbox-near.client';

const config = {
  get: () => ({ rpcUrls: {}, timeoutMs: 1000 }),
} as never;

type Handler = (params: any) => { result?: unknown; error?: unknown };

/** Answers each JSON-RPC method with its handler; `status` says testnet unless told. */
function node(handlers: Record<string, Handler>, chainId = 'testnet') {
  const calls: { method: string; params: any }[] = [];
  jest.spyOn(global, 'fetch').mockImplementation((_url, init) => {
    const { method, params } = JSON.parse(init?.body as string);
    calls.push({ method, params });
    const handler =
      method === 'status'
        ? () => ({ result: { chain_id: chainId } })
        : handlers[method];
    const answer = handler ? handler(params) : { error: { code: -1 } };
    return Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...answer })),
    );
  });
  return calls;
}

const bytes = (value: unknown) => [
  ...Buffer.from(JSON.stringify(value), 'utf8'),
];

const nearError = (name: string, data?: unknown) => ({
  error: {
    name: 'HANDLER_ERROR',
    cause: { name, info: {} },
    code: -32000,
    message: 'Server error',
    data,
  },
});

describe('SandboxNearClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('refuses a node that is not on NEAR testnet before any other call', async () => {
    const calls = node({}, 'mainnet');
    const err = await new SandboxNearClient(config)
      .ftBalanceOf('usdc', 'a')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(calls.map((c) => c.method)).toEqual(['status']);
  });

  it('reads a token balance and a registration through view calls on the final block', async () => {
    const calls = node({
      query: (p) =>
        p.method_name === 'ft_balance_of'
          ? { result: { result: bytes('25000000') } }
          : { result: { result: bytes(null) } },
    });
    const client = new SandboxNearClient(config);
    await expect(client.ftBalanceOf('usdc', 'abc')).resolves.toBe(25_000_000n);
    await expect(client.storageBalanceOf('usdc', 'abc')).resolves.toBeNull();
    const query = calls.find((c) => c.method === 'query')!.params;
    expect(query).toMatchObject({
      request_type: 'call_function',
      finality: 'final',
      account_id: 'usdc',
      method_name: 'ft_balance_of',
    });
    expect(
      JSON.parse(Buffer.from(query.args_base64, 'base64').toString()),
    ).toEqual({ account_id: 'abc' });
  });

  it('reads an account that does not exist yet as null', async () => {
    node({ query: () => nearError('UNKNOWN_ACCOUNT') });
    await expect(
      new SandboxNearClient(config).account('abc'),
    ).resolves.toBeNull();
  });

  it('reads an access key that does not exist as no nonce', async () => {
    node({
      query: () => ({
        result: { error: 'access key ed25519:x does not exist while viewing' },
      }),
    });
    await expect(
      new SandboxNearClient(config).accessKeyNonce('abc', 'ed25519:x'),
    ).resolves.toBeNull();
  });

  it('tells a final success, a final failure, a pending and an unknown transaction apart', async () => {
    const answers: Record<string, ReturnType<Handler>> = {
      ok: {
        result: {
          final_execution_status: 'FINAL',
          status: { SuccessValue: '' },
        },
      },
      bad: {
        result: {
          final_execution_status: 'FINAL',
          status: { Failure: { ActionError: { index: 1 } } },
        },
      },
      early: {
        result: {
          final_execution_status: 'INCLUDED',
          status: { SuccessValue: '' },
        },
      },
      gone: nearError('UNKNOWN_TRANSACTION'),
    };
    const calls = node({ tx: (p) => answers[p.tx_hash] });
    const client = new SandboxNearClient(config);
    await expect(client.transaction('ok', 's')).resolves.toEqual({
      state: 'succeeded',
    });
    await expect(client.transaction('bad', 's')).resolves.toMatchObject({
      state: 'failed',
    });
    await expect(client.transaction('early', 's')).resolves.toEqual({
      state: 'pending',
    });
    await expect(client.transaction('gone', 's')).resolves.toEqual({
      state: 'unknown',
    });
    expect(calls.find((c) => c.method === 'tx')!.params).toMatchObject({
      sender_account_id: 's',
      wait_until: 'NONE',
    });
  });

  it('reads an expired transaction as expired, a used nonce as accepted, and refuses the rest', async () => {
    const answers: Record<string, ReturnType<Handler>> = {
      expired: nearError('INVALID_TRANSACTION', {
        TxExecutionError: { InvalidTxError: 'Expired' },
      }),
      nonce: nearError('INVALID_TRANSACTION', {
        TxExecutionError: {
          InvalidTxError: { InvalidNonce: { tx_nonce: 5, ak_nonce: 6 } },
        },
      }),
      broke: nearError('INVALID_TRANSACTION', {
        TxExecutionError: {
          InvalidTxError: { NotEnoughBalance: { balance: '0' } },
        },
      }),
      fine: { result: { final_execution_status: 'INCLUDED' } },
    };
    const calls = node({ send_tx: (p) => answers[p.signed_tx_base64] });
    const client = new SandboxNearClient(config);
    await expect(client.sendTransaction('expired')).resolves.toBe('expired');
    await expect(client.sendTransaction('nonce')).resolves.toBe('accepted');
    await expect(client.sendTransaction('fine')).resolves.toBe('accepted');
    const err = await client.sendTransaction('broke').catch((e: unknown) => e);
    expect((err as ApiError).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect((err as ApiError).message).toMatch(/NotEnoughBalance/);
    expect(calls.find((c) => c.method === 'send_tx')!.params).toMatchObject({
      wait_until: 'INCLUDED',
    });
  });
});
