import { ApiError } from '@/common/errors/api-error';
import {
  SandboxSuiClient,
  SuiGraphqlError,
} from '@/sandbox-settlement/sandbox-sui.client';
import { SUI_TESTNET_CHAIN_IDENTIFIER } from '@/sandbox-settlement/sandbox-sui.constants';

const URL = 'https://sui-testnet.example/graphql';
const config = {
  get: () => ({ rpcUrls: { sui: URL }, timeoutMs: 1000 }),
} as never;

type Answer = { data?: unknown; errors?: { message: string }[] };

/** Answers each request by the first matching key found in its query text. */
function node(answers: Record<string, Answer>) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    const { query } = JSON.parse(init?.body as string) as { query: string };
    const key = Object.keys(answers).find((k) => query.includes(k));
    return new Response(JSON.stringify(key ? answers[key] : { data: null }), {
      status: 200,
    });
  });
}

const chain = (id = SUI_TESTNET_CHAIN_IDENTIFIER): Answer => ({
  data: { chainIdentifier: id },
});

describe('SandboxSuiClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('checks the chain identifier once, on the configured URL, and sends values as variables', async () => {
    const fetch = node({
      chainIdentifier: chain(),
      'balance(coinType': {
        data: {
          address: {
            balance: {
              totalBalance: '30',
              coinBalance: '10',
              addressBalance: '20',
            },
          },
        },
      },
    });
    const client = new SandboxSuiClient(config);
    await expect(client.balance('0xabc', '0x2::sui::SUI')).resolves.toEqual({
      total: 30n,
      coins: 10n,
      addressBalance: 20n,
    });
    await client.balance('0xabc', '0x2::sui::SUI');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0][0]).toBe(URL);
    const body = JSON.parse(fetch.mock.calls[1][1]?.body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.variables).toEqual({ owner: '0xabc', type: '0x2::sui::SUI' });
    expect(body.query).not.toContain('0xabc');
  });

  it('refuses a node on another network before any other call', async () => {
    const fetch = node({
      chainIdentifier: chain('4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S'),
    });
    const client = new SandboxSuiClient(config);
    const err = await client.referenceGasPrice().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).getStatus()).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reads an address with nothing as zero, and its coins largest first', async () => {
    node({
      chainIdentifier: chain(),
      'balance(coinType': { data: { address: null } },
      objects: {
        data: {
          address: {
            objects: {
              nodes: [
                {
                  address: '0x1',
                  version: 7,
                  digest: 'D1',
                  contents: { json: { balance: '5' } },
                },
                {
                  address: '0x2',
                  version: 9,
                  digest: 'D2',
                  contents: { json: { balance: '50' } },
                },
              ],
            },
          },
        },
      },
    });
    const client = new SandboxSuiClient(config);
    await expect(client.balance('0xabc', 'T')).resolves.toEqual({
      total: 0n,
      coins: 0n,
      addressBalance: 0n,
    });
    const coins = await client.coins('0xabc', 'T');
    expect(
      coins.map((c) => [c.ref.objectId, c.ref.version, c.balance]),
    ).toEqual([
      ['0x2', 9n, 50n],
      ['0x1', 7n, 5n],
    ]);
  });

  it('answers a transaction it does not know as null, and its status otherwise', async () => {
    node({
      chainIdentifier: chain(),
      'transaction(digest': { data: { transaction: null } },
    });
    const client = new SandboxSuiClient(config);
    await expect(client.transactionStatus('X')).resolves.toBeNull();
    jest.restoreAllMocks();
    node({
      chainIdentifier: chain(),
      'transaction(digest': {
        data: { transaction: { effects: { status: 'FAILURE' } } },
      },
    });
    await expect(client.transactionStatus('X')).resolves.toBe('FAILURE');
  });

  it('executes a signed transaction, and leaves a refusal for the ledger to read', async () => {
    node({
      chainIdentifier: chain(),
      executeTransaction: {
        data: { executeTransaction: { effects: { status: 'SUCCESS' } } },
      },
    });
    const client = new SandboxSuiClient(config);
    await expect(client.execute('dHg=', 'c2ln')).resolves.toBe('SUCCESS');
    jest.restoreAllMocks();
    node({
      chainIdentifier: chain(),
      executeTransaction: {
        errors: [{ message: 'Object 0x1 is not available for consumption' }],
      },
    });
    const err = await client.execute('dHg=', 'c2ln').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SuiGraphqlError);
    expect((err as Error).message).toMatch(/not available for consumption/);
  });

  it('answers a refused query as a 502 and a down node as a 503', async () => {
    node({
      chainIdentifier: chain(),
      epoch: { errors: [{ message: 'boom' }] },
    });
    const client = new SandboxSuiClient(config);
    const refused = await client.referenceGasPrice().catch((e: unknown) => e);
    expect((refused as ApiError).getStatus()).toBe(502);
    jest.restoreAllMocks();
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('busy', { status: 429 }));
    const down = await new SandboxSuiClient(config)
      .referenceGasPrice()
      .catch((e: unknown) => e);
    expect((down as ApiError).getStatus()).toBe(503);
  });
});
