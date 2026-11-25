import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { SandboxAptosClient } from '@/sandbox-settlement/sandbox-aptos.client';

const BASE = 'https://aptos-testnet.example/v1';
const config = {
  get: () => ({ rpcUrls: { aptos: BASE }, timeoutMs: 1000 }),
} as never;

type Route = (init?: RequestInit) => { status: number; body: unknown };

/** Answers each path (after the base URL) from `routes`; `/` is the chain check. */
function node(routes: Record<string, Route>, chainId = 2) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const path = (url as string).slice(BASE.length);
    const route =
      path === '/'
        ? () => ({ status: 200, body: { chain_id: chainId } })
        : routes[path];
    if (!route) throw new Error(`unexpected ${path}`);
    const { status, body } = route(init);
    return new Response(JSON.stringify(body), { status });
  });
}

const pathsOf = (fetch: jest.SpyInstance) =>
  fetch.mock.calls.map(([url]) => (url as string).slice(BASE.length));

describe('SandboxAptosClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('checks the chain id once, on the configured URL, before any read', async () => {
    const fetch = node({
      '/estimate_gas_price': () => ({
        status: 200,
        body: { gas_estimate: 100 },
      }),
    });
    const client = new SandboxAptosClient(config);
    await expect(client.gasUnitPrice('aptos')).resolves.toBe(100n);
    await client.gasUnitPrice('aptos');
    expect(pathsOf(fetch)).toEqual([
      '/',
      '/estimate_gas_price',
      '/estimate_gas_price',
    ]);
  });

  it('refuses a node on another chain (mainnet is 1), naming no setting to the caller', async () => {
    node({}, 1);
    const err = await new SandboxAptosClient(config)
      .gasUnitPrice('aptos')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(ApiErrorCode.Misconfigured);
    expect((err as ApiError).message).not.toMatch(/SANDBOX_RPC_URLS/);
  });

  it('reads a fungible-asset balance through the primary store view', async () => {
    const fetch = node({
      '/view': () => ({ status: 200, body: ['25000000'] }),
    });
    await expect(
      new SandboxAptosClient(config).faBalance('aptos', '0xa1', '0xb2'),
    ).resolves.toBe(25_000_000n);
    const [, init] = fetch.mock.calls[1];
    expect(JSON.parse(init?.body as string)).toEqual({
      function: '0x1::primary_fungible_store::balance',
      type_arguments: ['0x1::fungible_asset::Metadata'],
      arguments: ['0xa1', '0xb2'],
    });
  });

  it('answers a missing transaction as null, a pending or committed one by its state', async () => {
    node({
      '/transactions/by_hash/0x01': () => ({ status: 404, body: {} }),
      '/transactions/by_hash/0x02': () => ({
        status: 200,
        body: { type: 'pending_transaction', hash: '0x02' },
      }),
      '/transactions/by_hash/0x03': () => ({
        status: 200,
        body: {
          type: 'user_transaction',
          hash: '0x03',
          success: false,
          vm_status: 'Move abort',
        },
      }),
    });
    const client = new SandboxAptosClient(config);
    await expect(client.transactionByHash('aptos', '0x01')).resolves.toBeNull();
    await expect(client.transactionByHash('aptos', '0x02')).resolves.toEqual({
      state: 'pending',
    });
    await expect(client.transactionByHash('aptos', '0x03')).resolves.toEqual({
      state: 'committed',
      success: false,
      vmStatus: 'Move abort',
      hash: '0x03',
    });
  });

  it('submits BCS bytes, and takes "already there" as no error', async () => {
    let answer = { status: 202, body: { hash: '0x03' } } as {
      status: number;
      body: unknown;
    };
    const fetch = node({ '/transactions': () => answer });
    const client = new SandboxAptosClient(config);
    await client.submit('aptos', '0x0102');
    const [, init] = fetch.mock.calls[1];
    expect((init?.headers as Record<string, string>)['content-type']).toBe(
      'application/x.aptos.signed_transaction+bcs',
    );
    expect(Array.from(init?.body as Uint8Array)).toEqual([1, 2]);

    answer = {
      status: 400,
      body: { message: 'Invalid transaction: SEQUENCE_NUMBER_TOO_OLD' },
    };
    await expect(client.submit('aptos', '0x0102')).resolves.toBeUndefined();

    answer = {
      status: 400,
      body: { message: 'INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE' },
    };
    const err = await client.submit('aptos', '0x0102').catch((e: unknown) => e);
    expect((err as ApiError).code).toBe(ApiErrorCode.ProviderError);
  });

  it('answers a 5xx or a throttle as the node being unavailable', async () => {
    node({ '/estimate_gas_price': () => ({ status: 429, body: {} }) });
    const err = await new SandboxAptosClient(config)
      .gasUnitPrice('aptos')
      .catch((e: unknown) => e);
    expect((err as ApiError).code).toBe(ApiErrorCode.ProviderUnavailable);
  });

  it('refuses a network that is not Aptos', () => {
    expect(() => new SandboxAptosClient(config).network('base')).toThrow();
  });
});
