import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { SandboxXrplClient } from '@/sandbox-settlement/sandbox-xrpl.client';

const config = {
  get: () => ({
    rpcUrls: { xrp: 'https://xrpl-testnet.example' },
    timeoutMs: 1000,
  }),
} as never;

/**
 * Answers each rippled method from `answers` the way rippled does: the result
 * object, with `status: "error"` and an `error` code for a refusal.
 */
function node(answers: Record<string, Record<string, unknown>>) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    const { method, params } = JSON.parse(init?.body as string) as {
      method: string;
      params: [Record<string, unknown>];
    };
    expect(params[0].api_version).toBe(2);
    const answer = answers[method] ?? { status: 'error', error: 'unknownCmd' };
    return new Response(
      JSON.stringify({ result: { status: 'success', ...answer } }),
      { status: 200 },
    );
  });
}

const TESTNET = { info: { network_id: 1 } };
const ADDRESS = 'rN7Td1t4N7xDW8ohKpcvX1WiACRq9R8Ven';

describe('SandboxXrplClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('checks the network id once, on the configured URL', async () => {
    const fetch = node({
      server_info: TESTNET,
      account_info: {
        account_data: { Sequence: 5, Balance: '25000000', OwnerCount: 1 },
        account_flags: { requireDestinationTag: true },
      },
    });
    const client = new SandboxXrplClient(config);
    await expect(client.account('xrp', ADDRESS)).resolves.toEqual({
      sequence: 5,
      balance: 25_000_000n,
      ownerCount: 1,
      requireDestinationTag: true,
      depositAuth: false,
    });
    await client.account('xrp', ADDRESS);
    const methods = fetch.mock.calls.map(
      ([, init]) =>
        (JSON.parse(init?.body as string) as { method: string }).method,
    );
    expect(methods.filter((m) => m === 'server_info')).toHaveLength(1);
    expect(fetch.mock.calls[0][0] as string).toBe(
      'https://xrpl-testnet.example',
    );
  });

  it('refuses a node on mainnet', async () => {
    node({ server_info: { info: { network_id: 0 } } });
    const err = await new SandboxXrplClient(config)
      .account('xrp', ADDRESS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(ApiErrorCode.Misconfigured);
  });

  it('reads a missing account as null and a missing line as null', async () => {
    node({
      server_info: TESTNET,
      account_info: { status: 'error', error: 'actNotFound' },
      account_lines: {
        lines: [
          {
            account: 'rSomeOtherIssuerxxxxxxxxxxxxxxxx',
            currency: 'USD',
            balance: '1',
            limit: '10',
          },
        ],
      },
    });
    const client = new SandboxXrplClient(config);
    await expect(client.account('xrp', ADDRESS)).resolves.toBeNull();
    await expect(
      client.trustLine(
        'xrp',
        ADDRESS,
        'rHuGNhqTG32mfmAvWA8hUyWRLV3tCSwKQt',
        '5553444300000000000000000000000000000000',
      ),
    ).resolves.toBeNull();
  });

  it('tells a transaction absent from every searched ledger from one not looked for', async () => {
    node({
      server_info: TESTNET,
      tx: { status: 'error', error: 'txnNotFound', searched_all: true },
    });
    const client = new SandboxXrplClient(config);
    await expect(
      client.tx('xrp', 'AB'.repeat(32), { minLedger: 1, maxLedger: 1000 }),
    ).resolves.toEqual({ found: false, searchedAll: true });
  });

  it('answers the engine result of a submit, and a 502 for a blob the node cannot parse', async () => {
    node({
      server_info: TESTNET,
      submit: { engine_result: 'tefPAST_SEQ', engine_result_message: 'old' },
    });
    await expect(
      new SandboxXrplClient(config).submit('xrp', '12'),
    ).resolves.toEqual({ engineResult: 'tefPAST_SEQ', message: 'old' });
    jest.restoreAllMocks();
    node({
      server_info: TESTNET,
      submit: { status: 'error', error: 'invalidTransaction' },
    });
    const err = await new SandboxXrplClient(config)
      .submit('xrp', '12')
      .catch((e: unknown) => e);
    expect((err as ApiError).code).toBe(ApiErrorCode.ProviderError);
  });
});
