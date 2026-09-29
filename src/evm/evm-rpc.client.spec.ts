import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { EvmRpcClient } from '@/evm/evm-rpc.client';

const config = {
  get: () => ({
    rpcUrls: {
      public: 'https://rpc.monad.example',
      testnet: 'https://t.example',
    },
    timeoutMs: 1000,
    logBlockRange: 100,
  }),
} as never;

/** Answers each JSON-RPC method from `answers`, in call order. */
function node(answers: Record<string, unknown>) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    const { method } = JSON.parse(init?.body as string) as { method: string };
    const answer = answers[method];
    const body =
      answer instanceof Error
        ? { jsonrpc: '2.0', id: 1, error: { code: 3, message: answer.message } }
        : { jsonrpc: '2.0', id: 1, result: answer };
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

describe('EvmRpcClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('checks eth_chainId once per tier before trusting a node', async () => {
    const fetch = node({ eth_chainId: '0x8f', eth_blockNumber: '0x10' });
    const client = new EvmRpcClient(config);
    await expect(client.blockNumber('monad', 'public')).resolves.toBe(16n);
    await expect(client.blockNumber('monad', 'public')).resolves.toBe(16n);
    const methods = fetch.mock.calls.map(
      ([, init]) =>
        (JSON.parse(init?.body as string) as { method: string }).method,
    );
    expect(methods.filter((m) => m === 'eth_chainId')).toHaveLength(1);
  });

  it('refuses a node on another chain — a testnet URL configured as mainnet', async () => {
    node({ eth_chainId: '0x279f', eth_blockNumber: '0x10' });
    const err = await new EvmRpcClient(config)
      .blockNumber('monad', 'public')
      .then(() => null)
      .catch((e: unknown) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err!.code).toBe(ApiErrorCode.Misconfigured);
    expect(err!.message).toMatch(/MONAD_RPC_URL_MAINNET/);
  });

  it('reads ERC-20 decimals, and null for a revert or an account with no code', async () => {
    node({
      eth_chainId: '0x8f',
      eth_call: `0x${'6'.padStart(64, '0')}`,
    });
    const client = new EvmRpcClient(config);
    await expect(
      client.erc20Decimals('monad', 'public', '0xabc'),
    ).resolves.toBe(6);

    jest.restoreAllMocks();
    node({ eth_chainId: '0x8f', eth_call: '0x' });
    await expect(
      new EvmRpcClient(config).erc20Decimals('monad', 'public', '0xabc'),
    ).resolves.toBeNull();

    jest.restoreAllMocks();
    node({ eth_chainId: '0x8f', eth_call: new Error('execution reverted') });
    await expect(
      new EvmRpcClient(config).erc20Decimals('monad', 'public', '0xabc'),
    ).resolves.toBeNull();
  });

  it('answers any other JSON-RPC error as a 502', async () => {
    node({ eth_chainId: '0x8f', eth_blockNumber: new Error('boom') });
    const err = await new EvmRpcClient(config)
      .blockNumber('monad', 'public')
      .then(() => null)
      .catch((e: unknown) => e as ApiError);
    expect(err!.code).toBe(ApiErrorCode.ProviderError);
  });
});
