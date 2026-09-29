import { decodeBase58 } from '@/chains/chain-address';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { ChainPayLinkBuilder } from '@/payment-intents/chain-pay-link-builder.service';

const SOL_DEST = 'mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EVM_DEST = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const TOKEN = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';

function make(
  opts: {
    mintDecimals?: number | null;
    erc20Decimals?: number | null;
    deposits?: unknown;
  } = {},
) {
  const solana = {
    getMintDecimals: jest
      .fn()
      .mockResolvedValue(
        opts.mintDecimals === undefined ? 6 : opts.mintDecimals,
      ),
  };
  const evm = {
    erc20Decimals: jest
      .fn()
      .mockResolvedValue(
        opts.erc20Decimals === undefined ? 6 : opts.erc20Decimals,
      ),
    chainId: jest.fn().mockReturnValue(143),
    blockNumber: jest.fn().mockResolvedValue(12_345n),
  };
  // No relayer by default: the direct mode, paying the merchant.
  const deposits = opts.deposits ?? { isEnabled: () => false };
  return {
    builder: new ChainPayLinkBuilder(
      solana as never,
      evm as never,
      deposits as never,
    ),
    solana,
    evm,
  };
}

const codeOf = (p: Promise<unknown>) =>
  p.then(() => null).catch((e: unknown) => (e as ApiError).code);

describe('ChainPayLinkBuilder — solana', () => {
  it('builds a SOL transfer request with a fresh 32-byte reference', async () => {
    const { builder } = make();
    const base = {
      network: 'testnet' as const,
      destination: SOL_DEST,
      memo: '42',
    };
    const a = await builder.build('solana', { ...base, amount: '1.5' });
    const b = await builder.build('solana', { ...base, amount: '1.5' });

    expect(a.uri).toMatch(
      new RegExp(`^solana:${SOL_DEST}\\?amount=1\\.5&reference=`),
    );
    expect(decodeBase58(a.chainReference!)).toHaveLength(32);
    expect(a.chainReference).not.toBe(b.chainReference);
    expect(a).toMatchObject({
      asset: 'native',
      assetIssuer: null,
      assetDecimals: null,
    });
  });

  it('resolves an SPL token against the chain and keeps its decimals', async () => {
    const { builder, solana } = make({ mintDecimals: 6 });
    const link = await builder.build('solana', {
      network: 'public',
      destination: SOL_DEST,
      amount: '2.5',
      assetCode: 'usdc',
      assetIssuer: MINT,
      memo: '42',
    });
    expect(solana.getMintDecimals).toHaveBeenCalledWith('public', MINT);
    expect(link).toMatchObject({
      asset: 'USDC',
      assetIssuer: MINT,
      assetDecimals: 6,
    });
    expect(link.uri).toContain(`spl-token=${MINT}`);
  });

  it('refuses a mint that is not one, and more decimals than the token has', async () => {
    const req = {
      network: 'public' as const,
      destination: SOL_DEST,
      assetCode: 'USDC',
      assetIssuer: MINT,
      memo: '42',
    };
    expect(
      await codeOf(
        make({ mintDecimals: null }).builder.build('solana', {
          ...req,
          amount: '1',
        }),
      ),
    ).toBe(ApiErrorCode.ValidationFailed);
    expect(
      await codeOf(
        make().builder.build('solana', { ...req, amount: '1.0000001' }),
      ),
    ).toBe(ApiErrorCode.InvalidAmount);
  });
});

describe('ChainPayLinkBuilder — monad', () => {
  it('builds an EIP-681 ERC-20 link on the tier’s chain id and starts the cursor at the head', async () => {
    const { builder } = make();
    const link = await builder.build('monad', {
      network: 'public',
      destination: EVM_DEST.toLowerCase(),
      amount: '2.5',
      assetCode: 'USDC',
      assetIssuer: TOKEN.toLowerCase(),
      memo: '42',
    });
    expect(link.uri).toBe(
      `ethereum:${TOKEN}@143/transfer?address=${EVM_DEST}&uint256=2500000`,
    );
    expect(link).toMatchObject({
      destination: EVM_DEST,
      assetIssuer: TOKEN,
      chainCursor: '12345',
      chainReference: null,
    });
  });

  it('pays native MON in wei', async () => {
    const link = await make().builder.build('monad', {
      network: 'public',
      destination: EVM_DEST,
      amount: '1',
      memo: '42',
    });
    expect(link.uri).toBe(`ethereum:${EVM_DEST}@143?value=1000000000000000000`);
  });

  it('refuses an open amount, a message, and a contract that is not a token', async () => {
    const req = {
      network: 'public' as const,
      destination: EVM_DEST,
      memo: '42',
    };
    expect(await codeOf(make().builder.build('monad', req))).toBe(
      ApiErrorCode.InvalidAmount,
    );
    expect(
      await codeOf(
        make().builder.build('monad', { ...req, amount: '1', msg: 'hi' }),
      ),
    ).toBe(ApiErrorCode.ValidationFailed);
    expect(
      await codeOf(
        make({ erc20Decimals: null }).builder.build('monad', {
          ...req,
          amount: '1',
          assetCode: 'USDC',
          assetIssuer: TOKEN,
        }),
      ),
    ).toBe(ApiErrorCode.ValidationFailed);
  });

  it('refuses a token without a code, and the coin with an issuer', async () => {
    const req = {
      network: 'public' as const,
      destination: EVM_DEST,
      memo: '42',
      amount: '1',
    };
    expect(
      await codeOf(
        make().builder.build('monad', { ...req, assetIssuer: TOKEN }),
      ),
    ).toBe(ApiErrorCode.ValidationFailed);
    expect(
      await codeOf(
        make().builder.build('monad', {
          ...req,
          assetCode: 'MON',
          assetIssuer: TOKEN,
        }),
      ),
    ).toBe(ApiErrorCode.ValidationFailed);
  });
});

describe('ChainPayLinkBuilder — monad with deposit addresses', () => {
  const DEPOSIT = '0xC830d264C14ebDB31cdEa0Fb6f83C5b0D8EEc52F';
  const deposits = (fee: bigint) => ({
    isEnabled: () => true,
    mint: jest.fn(
      async (
        _chain: string,
        _network: string,
        destination: string,
        token: { address: string } | null,
      ) => ({
        address: DEPOSIT,
        salt: `0x${'11'.repeat(32)}`,
        destination,
        token: token?.address ?? null,
        relayer: '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
        fee,
      }),
    ),
  });

  it('points the link at the intent’s deposit address and shows the fee', async () => {
    const d = deposits(2n * 10n ** 16n);
    const { builder, evm } = make({ deposits: d });
    const link = await builder.build('monad', {
      network: 'public',
      destination: EVM_DEST,
      amount: '1',
      memo: '42',
    });
    expect(link.uri).toBe(`ethereum:${DEPOSIT}@143?value=1000000000000000000`);
    expect(link).toMatchObject({
      destination: EVM_DEST,
      chainReference: DEPOSIT,
      chainCursor: null,
      networkFee: '0.02',
    });
    expect(link.deposit).toMatchObject({ address: DEPOSIT, token: null });
    // No head block needed: the address is the identification, not a window.
    expect(evm.blockNumber).not.toHaveBeenCalled();
  });

  it('allows an open amount, which the deposit address makes recognisable', async () => {
    const { builder } = make({ deposits: deposits(0n) });
    const link = await builder.build('monad', {
      network: 'public',
      destination: EVM_DEST,
      assetCode: 'USDC',
      assetIssuer: TOKEN,
      memo: '42',
    });
    expect(link.uri).toBe(`ethereum:${TOKEN}@143/transfer?address=${DEPOSIT}`);
    expect(link.networkFee).toBeNull();
  });

  it('refuses an amount the fee would swallow', async () => {
    const { builder } = make({ deposits: deposits(10n ** 18n) });
    expect(
      await codeOf(
        builder.build('monad', {
          network: 'public',
          destination: EVM_DEST,
          amount: '1',
          memo: '42',
        }),
      ),
    ).toBe(ApiErrorCode.InvalidAmount);
  });
});
