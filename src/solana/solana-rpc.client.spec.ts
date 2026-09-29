import { SOLANA_GENESIS_HASHES } from '@/chains/chains.constants';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { SolanaRpcClient } from '@/solana/solana-rpc.client';
import { SPL_TOKEN_PROGRAM_ID } from '@/solana/solana.constants';

const config = {
  get: () => ({
    rpcUrls: { public: 'https://sol.example', testnet: 'https://dev.example' },
    timeoutMs: 1000,
  }),
} as never;

function node(answers: Record<string, unknown>) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    const { method } = JSON.parse(init?.body as string) as { method: string };
    const answer = answers[method];
    const body =
      answer instanceof Error
        ? {
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32602, message: answer.message },
          }
        : { jsonrpc: '2.0', id: 1, result: answer };
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

describe('SolanaRpcClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('refuses a node on the wrong cluster', async () => {
    node({ getGenesisHash: SOLANA_GENESIS_HASHES.testnet });
    const err = await new SolanaRpcClient(config)
      .getTransaction('public', 'sig')
      .then(() => null)
      .catch((e: unknown) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err!.code).toBe(ApiErrorCode.Misconfigured);
  });

  it('answers a missing or malformed signature as no transaction', async () => {
    node({
      getGenesisHash: SOLANA_GENESIS_HASHES.public,
      getTransaction: null,
    });
    await expect(
      new SolanaRpcClient(config).getTransaction('public', 'sig'),
    ).resolves.toBeNull();

    jest.restoreAllMocks();
    node({
      getGenesisHash: SOLANA_GENESIS_HASHES.public,
      getTransaction: new Error('Invalid param'),
    });
    await expect(
      new SolanaRpcClient(config).getTransaction('public', 'sig'),
    ).resolves.toBeNull();
  });

  it('reads a mint’s decimals, and null for anything that is not a mint', async () => {
    node({
      getGenesisHash: SOLANA_GENESIS_HASHES.testnet,
      getAccountInfo: {
        value: {
          owner: SPL_TOKEN_PROGRAM_ID,
          data: { parsed: { type: 'mint', info: { decimals: 6 } } },
        },
      },
    });
    await expect(
      new SolanaRpcClient(config).getMintDecimals('testnet', 'mint'),
    ).resolves.toBe(6);

    jest.restoreAllMocks();
    node({
      getGenesisHash: SOLANA_GENESIS_HASHES.testnet,
      getAccountInfo: {
        value: { owner: '11111111111111111111111111111111', data: {} },
      },
    });
    await expect(
      new SolanaRpcClient(config).getMintDecimals('testnet', 'wallet'),
    ).resolves.toBeNull();
  });
});
