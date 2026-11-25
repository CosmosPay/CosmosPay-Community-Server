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

describe('EvmRpcClient on Arc', () => {
  afterEach(() => jest.restoreAllMocks());

  const arcConfig = {
    get: (key: string) =>
      key === 'arc'
        ? {
            rpcUrls: {
              public: 'https://rpc.mainnet.arc.io',
              testnet: 'https://rpc.testnet.arc.io',
            },
            timeoutMs: 1000,
            logBlockRange: 5_000,
          }
        : null,
  } as never;

  it('knows Arc’s hard-coded chain ids', () => {
    const client = new EvmRpcClient(arcConfig);
    expect(client.chainId('arc', 'public')).toBe(5042);
    expect(client.chainId('arc', 'testnet')).toBe(5042002);
    expect(client.logBlockRange('arc')).toBe(5_000);
  });

  it('trusts a node that answers Arc Testnet’s id (0x4cef52) on the testnet tier, at its own URL', async () => {
    const fetch = node({ eth_chainId: '0x4cef52', eth_blockNumber: '0x10' });
    await expect(
      new EvmRpcClient(arcConfig).blockNumber('arc', 'testnet'),
    ).resolves.toBe(16n);
    expect(fetch.mock.calls[0][0]).toBe('https://rpc.testnet.arc.io');
  });

  it('refuses Arc Testnet configured as mainnet, naming ARC_RPC_URL_MAINNET', async () => {
    node({ eth_chainId: '0x4cef52', eth_blockNumber: '0x10' });
    const err = await new EvmRpcClient(arcConfig)
      .blockNumber('arc', 'public')
      .then(() => null)
      .catch((e: unknown) => e as ApiError);
    expect(err!.code).toBe(ApiErrorCode.Misconfigured);
    expect(err!.message).toMatch(/Arc RPC/);
    expect(err!.message).toMatch(/serves chain 5042002, not 5042/);
    expect(err!.message).toMatch(/ARC_RPC_URL_MAINNET/);
  });

  it('refuses a Monad node configured for Arc', async () => {
    node({ eth_chainId: '0x8f', eth_blockNumber: '0x10' });
    const err = await new EvmRpcClient(arcConfig)
      .blockNumber('arc', 'public')
      .then(() => null)
      .catch((e: unknown) => e as ApiError);
    expect(err!.code).toBe(ApiErrorCode.Misconfigured);
  });
});
