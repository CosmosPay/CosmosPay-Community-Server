import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  erc20TransferCalldata,
  SandboxEvmClient,
} from '@/sandbox-settlement/sandbox-evm.client';

const config = {
  get: () => ({
    rpcUrls: { base: 'https://base-sepolia.example' },
    timeoutMs: 1000,
  }),
} as never;

/** Answers each JSON-RPC method from `answers`; an Error is a JSON-RPC error. */
function node(answers: Record<string, unknown>) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const { method } = JSON.parse(init?.body as string) as { method: string };
    const answer = answers[method];
    const body =
      answer instanceof Error
        ? {
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32000, message: answer.message },
          }
        : { jsonrpc: '2.0', id: 1, result: answer };
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

const methodsOf = (fetch: jest.SpyInstance) =>
  fetch.mock.calls.map(
    ([, init]) =>
      (JSON.parse(init?.body as string) as { method: string }).method,
  );

describe('SandboxEvmClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('checks the test network chain id once, on the configured URL', async () => {
    const fetch = node({
      eth_chainId: '0x14a34', // 84532, Base Sepolia
      eth_getBalance: '0x10',
    });
    const client = new SandboxEvmClient(config);
    await expect(
      client.nativeBalance('base', '0x' + '1'.repeat(40)),
    ).resolves.toBe(16n);
    await expect(
      client.nativeBalance('base', '0x' + '1'.repeat(40)),
    ).resolves.toBe(16n);
    expect(methodsOf(fetch).filter((m) => m === 'eth_chainId')).toHaveLength(1);
    expect(fetch.mock.calls[0][0] as string).toBe(
      'https://base-sepolia.example',
    );
  });

  it('refuses a node on another chain, a mainnet above all', async () => {
    node({ eth_chainId: '0x2105' }); // 8453: Base MAINNET
    const client = new SandboxEvmClient(config);
    const err = await client
      .nativeBalance('base', '0x' + '1'.repeat(40))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(ApiErrorCode.Misconfigured);
  });

  it('only knows the sandbox EVM test networks', () => {
    const client = new SandboxEvmClient(config);
    expect(() => client.network('btc')).toThrow(/not an EVM test network/);
    expect(client.network('eth').chainId).toBe(11155111);
  });

  it('takes a rebroadcast of a known transaction as sent', async () => {
    node({
      eth_chainId: '0x14a34',
      eth_sendRawTransaction: new Error('already known'),
    });
    const client = new SandboxEvmClient(config);
    await expect(
      client.sendRawTransaction('base', '0x02'),
    ).resolves.toBeUndefined();
  });

  it('answers a refused transaction as a 502, naming the test network', async () => {
    node({
      eth_chainId: '0x14a34',
      eth_sendRawTransaction: new Error('insufficient funds for gas'),
    });
    const client = new SandboxEvmClient(config);
    const err = await client
      .sendRawTransaction('base', '0x02')
      .catch((e: unknown) => e);
    expect((err as ApiError).code).toBe(ApiErrorCode.ProviderError);
    expect((err as ApiError).message).toMatch(/Base Sepolia refused/);
  });

  it('bids the gas price when the node has no priority fee method', async () => {
    node({
      eth_chainId: '0x14a34',
      eth_gasPrice: '0x64', // 100
      eth_maxPriorityFeePerGas: new Error('method not found'),
    });
    const client = new SandboxEvmClient(config);
    await expect(client.feeData('base')).resolves.toEqual({
      maxFeePerGas: 300n,
      maxPriorityFeePerGas: 100n,
    });
  });

  it('reads a receipt: null until mined, then its outcome', async () => {
    node({ eth_chainId: '0x14a34', eth_getTransactionReceipt: null });
    const client = new SandboxEvmClient(config);
    await expect(client.receipt('base', '0xabc')).resolves.toBeNull();
    jest.restoreAllMocks();
    node({
      eth_chainId: '0x14a34',
      eth_getTransactionReceipt: { status: '0x0', blockNumber: '0x5' },
    });
    await expect(
      new SandboxEvmClient(config).receipt('base', '0xabc'),
    ).resolves.toEqual({
      succeeded: false,
      blockNumber: 5n,
    });
  });

  it('encodes an ERC-20 transfer', () => {
    expect(erc20TransferCalldata('0x' + 'AB'.repeat(20), 1_000_000n)).toBe(
      '0xa9059cbb' +
        '000000000000000000000000' +
        'ab'.repeat(20) +
        '00000000000000000000000000000000000000000000000000000000000f4240',
    );
  });
});
