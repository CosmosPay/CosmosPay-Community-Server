import { ed25519 } from '@noble/curves/ed25519.js';
import type { ChainSwap } from '@generated/prisma/client';
import { encodeBase58 } from '@/chains/chain-address';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { EvmRpcClient } from '@/evm/evm-rpc.client';
import { addressOfSecretKey, signEip1559 } from '@/evm/evm-transaction';
import type { JupiterClient } from '@/jupiter/jupiter.client';
import type { KuruClient } from '@/kuru/kuru.client';
import { associatedTokenAddress } from '@/solana/associated-token-account';
import type { SolanaRpcClient } from '@/solana/solana-rpc.client';
import { MonadSwapVenue } from '@/swaps/venues/monad-swap.venue';
import { SolanaSwapVenue } from '@/swaps/venues/solana-swap.venue';

function codeOf(fn: () => unknown): ApiErrorCode | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof ApiError ? err.code : undefined;
  }
  return undefined;
}

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('expected a rejection');
}

const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('SolanaSwapVenue', () => {
  const secret = ed25519.utils.randomSecretKey();
  const payer = ed25519.getPublicKey(secret);
  const source = encodeBase58(payer);
  const msg = Uint8Array.from([
    0x80,
    1,
    0,
    1,
    2,
    ...payer,
    ...new Uint8Array(32).fill(9),
    ...new Uint8Array(32).fill(7),
    0,
    0,
  ]);
  const b64 = (sig: Uint8Array, m = msg) =>
    Buffer.from(Uint8Array.from([1, ...sig, ...m])).toString('base64');
  const swap = {
    source,
    transaction: { encoding: 'base64', data: b64(new Uint8Array(64)) },
  } as unknown as ChainSwap;

  function venue(rpc: Partial<Record<keyof SolanaRpcClient, jest.Mock>> = {}) {
    const jupiter = {
      quote: jest.fn().mockResolvedValue({
        outAmount: '11878546',
        otherAmountThreshold: '11819154',
        platformFee: { amount: '59691', feeBps: 50 },
        routePlan: [
          { swapInfo: { inputMint: 'So1', outputMint: 'MID' } },
          { swapInfo: { inputMint: 'MID', outputMint: USDC_SOL } },
        ],
      }),
      swapTransaction: jest.fn().mockResolvedValue({
        swapTransaction: 'AAAA',
        lastValidBlockHeight: 7,
      }),
    };
    return {
      jupiter,
      venue: new SolanaSwapVenue(
        jupiter as unknown as JupiterClient,
        rpc as unknown as SolanaRpcClient,
      ),
    };
  }

  const REQUEST = {
    source,
    send: { asset: 'native', decimals: 9 },
    dest: { asset: USDC_SOL, decimals: 6 },
    amount: 100_000_000n,
    slippageBps: 50,
    feeBps: 50,
    feeWallet: '13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK',
  };

  it('verifies a transaction signed by the source over the bytes it was handed', () => {
    const { venue: v } = venue();
    const id = v.verify(swap, b64(ed25519.sign(msg, secret)));
    expect(typeof id).toBe('string');
  });

  it('refuses the built transaction left unsigned, and any other message', () => {
    const { venue: v } = venue();
    expect(codeOf(() => v.verify(swap, b64(new Uint8Array(64))))).toBe(
      ApiErrorCode.ValidationFailed,
    );
    const other = Uint8Array.from(msg);
    other[other.length - 3] ^= 1;
    expect(
      codeOf(() => v.verify(swap, b64(ed25519.sign(other, secret), other))),
    ).toBe(ApiErrorCode.ValidationFailed);
    expect(codeOf(() => v.verify(swap, 'not base64 at all'))).toBe(
      ApiErrorCode.ValidationFailed,
    );
  });

  it('prices with the fee taken from the output and reports the route hops', async () => {
    const { venue: v } = venue();
    const q = await v.quote(REQUEST);
    expect(q).toMatchObject({
      destEstimated: 11878546n,
      destMin: 11819154n,
      feeAmount: 59691n,
      path: [{ code: 'MID', issuer: null }],
    });
  });

  it('pays the commission into the fee wallet token account, and refuses when it is missing', async () => {
    const owners: Record<string, string | null> = {
      [USDC_SOL]: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    };
    const getAccountOwner = jest.fn(
      async (_n: string, a: string) => owners[a] ?? null,
    );
    const { venue: v } = venue({ getAccountOwner });

    const err = await rejection(v.build(REQUEST));
    expect(err.code).toBe(ApiErrorCode.Misconfigured);
    expect(err.message).toContain('SOLANA_SWAP_FEE_WALLET');

    // Once the account exists, the build names it.
    getAccountOwner.mockResolvedValue(
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    );
    const { venue: ok, jupiter } = venue({ getAccountOwner });
    const built = await ok.build(REQUEST);
    expect(jupiter.swapTransaction.mock.calls[0][0].feeAccount).toBe(
      associatedTokenAddress(
        REQUEST.feeWallet,
        USDC_SOL,
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      ),
    );
    expect(built.transaction).toEqual({
      encoding: 'base64',
      data: 'AAAA',
      lastValidBlockHeight: 7,
    });
  });

  it('reads settlement from the signature status', async () => {
    const getSignatureStatus = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ err: null, confirmationStatus: 'confirmed' })
      .mockResolvedValueOnce({
        err: { InstructionError: [] },
        confirmationStatus: 'confirmed',
      });
    const { venue: v } = venue({ getSignatureStatus });
    await expect(v.settlement('sig')).resolves.toBeNull();
    await expect(v.settlement('sig')).resolves.toBe('SUCCEEDED');
    await expect(v.settlement('sig')).resolves.toBe('FAILED');
  });
});

describe('MonadSwapVenue', () => {
  const key = new Uint8Array(32).fill(3);
  const source = addressOfSecretKey(key);
  const ROUTER = '0xb3e6778480b2E488385E8205eA05E20060B813cb';
  const USDC = '0x754704bc059f8c67012fed69bc8a327a5aafb603';
  const built = {
    to: ROUTER,
    data: '0xce1e7030',
    value: '10000000000000000000',
    chainId: 143,
  };
  const swap = { source, transaction: built } as unknown as ChainSwap;
  const sign = (over: Partial<typeof built> = {}, k = key) =>
    signEip1559(
      {
        chainId: over.chainId ?? built.chainId,
        nonce: 1n,
        maxPriorityFeePerGas: 1n,
        maxFeePerGas: 100n,
        gasLimit: 300_000n,
        to: over.to ?? built.to,
        value: BigInt(over.value ?? built.value),
        data: over.data ?? built.data,
      },
      k,
    ).raw;

  function venue(rpc: Record<string, jest.Mock> = {}) {
    const kuru = {
      quote: jest.fn().mockResolvedValue({
        output: '284466',
        minOut: '283044',
        transaction: {
          to: ROUTER.toLowerCase(),
          calldata: 'CE1E7030',
          value: '0',
        },
      }),
    };
    return {
      kuru,
      venue: new MonadSwapVenue(
        kuru as unknown as KuruClient,
        rpc as unknown as EvmRpcClient,
      ),
    };
  }

  it('verifies the call it built, signed by the source, and answers its hash', () => {
    const { venue: v } = venue();
    expect(v.verify(swap, sign())).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('refuses another router, other calldata, another value, another chain or signer', () => {
    const { venue: v } = venue();
    for (const raw of [
      sign({ to: '0x1111111111111111111111111111111111111111' }),
      sign({ data: '0xdeadbeef' }),
      sign({ value: '1' }),
      sign({ chainId: 10143 }),
      sign({}, new Uint8Array(32).fill(4)),
    ]) {
      expect(codeOf(() => v.verify(swap, raw))).toBe(
        ApiErrorCode.ValidationFailed,
      );
    }
  });

  it('asks for an exact approval when selling an ERC-20 with too small an allowance', async () => {
    const erc20Allowance = jest.fn().mockResolvedValue(0n);
    const { venue: v } = venue({ erc20Allowance });
    const out = await v.build({
      source,
      send: { asset: USDC, decimals: 6 },
      dest: { asset: 'native', decimals: 18 },
      amount: 1_000_000n,
      slippageBps: 50,
      feeBps: 100,
      feeWallet: '0x62ee1b8d1efdf8f73c78db87b888406b194e266a',
    });
    expect(out.approval).toEqual({
      to: USDC,
      data: expect.stringMatching(/^0x095ea7b3.+0f4240$/),
      value: '0',
      chainId: 143,
    });
    expect(out.transaction).toMatchObject({
      to: ROUTER,
      data: '0xce1e7030',
      chainId: 143,
    });
    // Kuru's output is already net of the 1% fee: 284466 × 100 / 9900.
    expect(out.feeAmount).toBe(2873n);
  });

  it('needs no approval to sell native MON', async () => {
    const erc20Allowance = jest.fn();
    const { venue: v } = venue({ erc20Allowance });
    const out = await v.build({
      source,
      send: { asset: 'native', decimals: 18 },
      dest: { asset: USDC, decimals: 6 },
      amount: 10n ** 19n,
      slippageBps: 50,
      feeBps: 0,
      feeWallet: null,
    });
    expect(out.approval).toBeNull();
    expect(erc20Allowance).not.toHaveBeenCalled();
    expect(out.feeAmount).toBe(0n);
  });

  it('reads settlement from the receipt', async () => {
    const getReceipt = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: '0x1' })
      .mockResolvedValueOnce({ status: '0x0' });
    const { venue: v } = venue({ getReceipt });
    await expect(v.settlement('0xh')).resolves.toBeNull();
    await expect(v.settlement('0xh')).resolves.toBe('SUCCEEDED');
    await expect(v.settlement('0xh')).resolves.toBe('FAILED');
  });
});
