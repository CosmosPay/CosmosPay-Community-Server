import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { ARC_USDC, EVM_TOKEN_PRESETS } from '@/evm/evm.constants';
import {
  ChainPayLinkBuilder,
  evmPresetOf,
} from '@/payment-intents/chain-pay-link-builder.service';

const DEST = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const DEPOSIT = '0xC830d264C14ebDB31cdEa0Fb6f83C5b0D8EEc52F';
const FEE_WALLET = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const EURC_MAINNET = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1';
const EURC_TESTNET = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const OTHER_TOKEN = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';

function make(opts: { deposits?: unknown; erc20Decimals?: number } = {}) {
  const evm = {
    erc20Decimals: jest.fn().mockResolvedValue(opts.erc20Decimals ?? 18),
    // The real ids: the builder writes whatever the client answers.
    chainId: jest.fn((_chain: string, network: string) =>
      network === 'public' ? 5042 : 5042002,
    ),
    blockNumber: jest.fn().mockResolvedValue(72_862_339n),
  };
  const deposits = opts.deposits ?? { isEnabled: () => false };
  return {
    builder: new ChainPayLinkBuilder(
      {} as never,
      evm as never,
      deposits as never,
    ),
    evm,
  };
}

const deposits = (fee: bigint) => ({
  isEnabled: jest.fn((chain: string) => chain === 'arc'),
  mint: jest.fn(
    async (
      _chain: string,
      _network: string,
      destination: string,
      token: { address: string } | null,
      merchantFee: { wallet: string; amount: bigint } | null,
    ) => ({
      address: DEPOSIT,
      salt: `0x${'11'.repeat(32)}`,
      destination,
      token: token?.address ?? null,
      relayer: '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      fee,
      merchantFee,
    }),
  ),
});

const codeOf = (p: Promise<unknown>) =>
  p.then(() => null).catch((e: unknown) => (e as ApiError).code);

describe('evmPresetOf: what a code alone names on Arc', () => {
  it('reads USDC, native and an omitted asset as USDC through its ERC-20 interface', () => {
    const usdc = { code: 'USDC', issuer: ARC_USDC, decimals: 6 };
    expect(evmPresetOf('arc', 'public', undefined, undefined)).toEqual(usdc);
    expect(evmPresetOf('arc', 'public', 'native', undefined)).toEqual(usdc);
    expect(evmPresetOf('arc', 'testnet', 'usdc', undefined)).toEqual(usdc);
    // The interface's own address with its code is the same asset.
    expect(evmPresetOf('arc', 'public', 'USDC', ARC_USDC)).toEqual(usdc);
  });

  it('reads EURC as the tier’s own EURC', () => {
    expect(evmPresetOf('arc', 'public', 'EURC', undefined)).toEqual({
      code: 'EURC',
      issuer: EURC_MAINNET,
      decimals: 6,
    });
    expect(evmPresetOf('arc', 'testnet', 'eurc', undefined)).toEqual({
      code: 'EURC',
      issuer: EURC_TESTNET,
      decimals: 6,
    });
    // Mainnet's EURC is not the testnet's: named on the wrong tier, it is a
    // token by contract, read on-chain.
    expect(evmPresetOf('arc', 'testnet', 'EURC', EURC_MAINNET)).toBeNull();
  });

  it('leaves every other token to its contract, and Monad (no presets) as it was', () => {
    expect(evmPresetOf('arc', 'public', 'WETH', OTHER_TOKEN)).toBeNull();
    expect(evmPresetOf('arc', 'public', 'USDC', OTHER_TOKEN)).toBeNull();
    expect(evmPresetOf('monad', 'public', undefined, undefined)).toBeNull();
    expect(evmPresetOf('monad', 'public', 'USDC', undefined)).toBeNull();
  });

  it('pins presets that are checksummed, 6-decimal, and USDC the gas coin on both tiers', () => {
    for (const tier of ['public', 'testnet'] as const) {
      const presets = EVM_TOKEN_PRESETS.arc[tier];
      expect(Object.keys(presets).sort()).toEqual(['EURC', 'USDC']);
      expect(presets.USDC.address).toBe(ARC_USDC);
      for (const p of Object.values(presets)) {
        expect(p.decimals).toBe(6);
        expect(p.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    }
    expect(EVM_TOKEN_PRESETS.monad).toEqual({ public: {}, testnet: {} });
  });
});

describe('ChainPayLinkBuilder on Arc, paying the merchant directly', () => {
  it('builds the EIP-681 transfer on USDC’s interface with Arc’s chain id, in 6 decimals', async () => {
    const { builder, evm } = make();
    const link = await builder.build('arc', {
      network: 'public',
      destination: DEST.toLowerCase(),
      amount: '12.5',
      memo: '42',
    });
    expect(link.uri).toBe(
      `ethereum:${ARC_USDC}@5042/transfer?address=${DEST}&uint256=12500000`,
    );
    expect(link).toMatchObject({
      destination: DEST,
      asset: 'USDC',
      assetIssuer: ARC_USDC,
      assetDecimals: 6,
      chainReference: null,
      chainCursor: '72862339',
      networkFee: null,
      deposit: null,
    });
    // A preset needs no on-chain read of its decimals.
    expect(evm.erc20Decimals).not.toHaveBeenCalled();
    expect(evm.blockNumber).toHaveBeenCalledWith('arc', 'public');
  });

  it('writes Arc Testnet’s chain id for a dev key, and its EURC', async () => {
    const { builder } = make();
    const link = await builder.build('arc', {
      network: 'testnet',
      destination: DEST,
      amount: '3',
      assetCode: 'EURC',
      memo: '42',
    });
    expect(link.uri).toBe(
      `ethereum:${EURC_TESTNET}@5042002/transfer?address=${DEST}&uint256=3000000`,
    );
  });

  it('accepts any other ERC-20 by contract, reading its decimals on Arc', async () => {
    const { builder, evm } = make({ erc20Decimals: 18 });
    const link = await builder.build('arc', {
      network: 'public',
      destination: DEST,
      amount: '1',
      assetCode: 'weth',
      assetIssuer: OTHER_TOKEN,
      memo: '42',
    });
    expect(evm.erc20Decimals).toHaveBeenCalledWith(
      'arc',
      'public',
      OTHER_TOKEN,
    );
    expect(link).toMatchObject({ asset: 'WETH', assetDecimals: 18 });
    expect(link.uri).toBe(
      `ethereum:${OTHER_TOKEN}@5042/transfer?address=${DEST}&uint256=1000000000000000000`,
    );
  });

  it('needs an amount, at most 6 decimals for USDC, and takes no msg or merchant fee', async () => {
    const base = { network: 'public' as const, destination: DEST, memo: '42' };
    expect(await codeOf(make().builder.build('arc', base))).toBe(
      ApiErrorCode.InvalidAmount,
    );
    expect(
      await codeOf(
        make().builder.build('arc', { ...base, amount: '1.0000001' }),
      ),
    ).toBe(ApiErrorCode.InvalidAmount);
    expect(
      await codeOf(
        make().builder.build('arc', { ...base, amount: '1', msg: 'hi' }),
      ),
    ).toBe(ApiErrorCode.ValidationFailed);
    const err = (await make()
      .builder.build('arc', {
        ...base,
        amount: '1',
        merchantFee: { bps: 100, wallet: FEE_WALLET },
      })
      .then(
        () => null,
        (e: unknown) => e,
      )) as ApiError;
    expect(err.code).toBe(ApiErrorCode.MerchantFeeUnsupported);
    expect(err.message).toMatch(/payment link on Arc/);
    expect(err.message).toMatch(/ARC_RELAYER_PRIVATE_KEY/);
  });

  it('normalizes a request to what it stores, so a replay compares like with like', () => {
    const { builder } = make();
    expect(
      builder.normalize('arc', 'testnet', { destination: DEST.toLowerCase() }),
    ).toEqual({ destination: DEST, asset: 'USDC', assetIssuer: ARC_USDC });
    expect(
      builder.normalize('arc', 'testnet', {
        destination: DEST,
        assetCode: 'EURC',
      }),
    ).toEqual({ destination: DEST, asset: 'EURC', assetIssuer: EURC_TESTNET });
    // Monad is untouched: its coin stays `native`.
    expect(builder.normalize('monad', 'public', { destination: DEST })).toEqual(
      { destination: DEST, asset: 'native', assetIssuer: null },
    );
  });
});

describe('ChainPayLinkBuilder on Arc with deposit addresses', () => {
  it('points the USDC transfer at the intent’s deposit address and shows the fee in USDC', async () => {
    const d = deposits(16_250n);
    const { builder, evm } = make({ deposits: d });
    const link = await builder.build('arc', {
      network: 'testnet',
      destination: DEST,
      amount: '10',
      memo: '42',
    });
    expect(link.uri).toBe(
      `ethereum:${ARC_USDC}@5042002/transfer?address=${DEPOSIT}&uint256=10000000`,
    );
    expect(d.mint).toHaveBeenCalledWith(
      'arc',
      'testnet',
      DEST,
      { address: ARC_USDC, decimals: 6 },
      null,
    );
    expect(link).toMatchObject({
      chainReference: DEPOSIT,
      chainCursor: null,
      networkFee: '0.01625',
    });
    expect(evm.blockNumber).not.toHaveBeenCalled();
  });

  it('allows an open amount, and a merchant fee the deposit address pays out', async () => {
    const open = await make({ deposits: deposits(0n) }).builder.build('arc', {
      network: 'public',
      destination: DEST,
      memo: '42',
    });
    expect(open.uri).toBe(
      `ethereum:${ARC_USDC}@5042/transfer?address=${DEPOSIT}`,
    );

    const d = deposits(16_250n);
    const link = await make({ deposits: d }).builder.build('arc', {
      network: 'public',
      destination: DEST,
      amount: '10',
      memo: '42',
      merchantFee: { bps: 100, wallet: FEE_WALLET, paidBy: 'payer' },
    });
    // 10 USDC plus 1%: the payer deposits 10.1, the forwarder pays 0.1 out.
    expect(link.uri).toBe(
      `ethereum:${ARC_USDC}@5042/transfer?address=${DEPOSIT}&uint256=10100000`,
    );
    expect(d.mint.mock.calls[0][4]).toEqual({
      wallet: FEE_WALLET,
      amount: 100_000n,
    });
    expect(link.merchantFee?.record).toMatchObject({
      amount: '0.1',
      asset: 'USDC',
      paidBy: 'payer',
    });
  });
});
