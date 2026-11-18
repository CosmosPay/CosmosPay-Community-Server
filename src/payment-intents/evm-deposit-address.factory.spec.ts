import { depositAddress, forwarderInitCode } from '@/evm/payment-forwarder';
import { EvmDepositAddressFactory } from '@/payment-intents/evm-deposit-address.factory';

const DEST = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const RELAYER = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const TOKEN = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';

function make(tokenFees: Record<string, string> = {}) {
  const config = { get: () => ({ depositTokenFees: tokenFees }) };
  // 102 gwei — Monad's gas price when this was measured.
  const rpc = { gasPrice: jest.fn().mockResolvedValue(102_000_000_000n) };
  const relayer = {
    isEnabled: () => true,
    address: () => RELAYER,
  };
  return new EvmDepositAddressFactory(
    config as never,
    rpc as never,
    relayer as never,
  );
}

describe('EvmDepositAddressFactory', () => {
  it('prices a native deposit from the gas price, with margin, rounded up', async () => {
    const terms = await make().mint('monad', 'public', DEST, null);
    // 450k gas × 102 gwei × 1.25 = 0.057375 MON, already a round micro-MON.
    expect(terms.fee).toBe(57_375_000_000_000_000n);
    expect(EvmDepositAddressFactory.displayFee(terms.fee, 18)).toBe('0.057375');
  });

  it('mints an address that is exactly the CREATE2 of its own terms', async () => {
    const terms = await make().mint('monad', 'public', DEST, null);
    expect(terms.address).toBe(
      depositAddress(
        terms.salt,
        forwarderInitCode({
          destination: DEST,
          token: null,
          relayer: RELAYER,
          fee: terms.fee,
        }),
      ),
    );
    expect(terms.salt).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('never mints the same address twice', async () => {
    const factory = make();
    const a = await factory.mint('monad', 'public', DEST, null);
    const b = await factory.mint('monad', 'public', DEST, null);
    expect(a.address).not.toBe(b.address);
  });

  it('charges a token deposit the operator’s configured fee, or nothing', async () => {
    const configured = await make({ [TOKEN.toLowerCase()]: '0.05' }).mint(
      'monad',
      'public',
      DEST,
      { address: TOKEN, decimals: 6 },
    );
    expect(configured.fee).toBe(50_000n);

    const unconfigured = await make().mint('monad', 'public', DEST, {
      address: TOKEN,
      decimals: 6,
    });
    expect(unconfigured.fee).toBe(0n);
  });

  it('rounds a configured fee down to what the token can express', async () => {
    const terms = await make({ [TOKEN.toLowerCase()]: '0.0512345678' }).mint(
      'monad',
      'public',
      DEST,
      { address: TOKEN, decimals: 6 },
    );
    expect(terms.fee).toBe(51_234n);
  });
});

describe('EvmDepositAddressFactory on Arc', () => {
  const USDC = '0x3600000000000000000000000000000000000000';
  const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

  function arc(tokenFees: Record<string, string> = {}) {
    const config = { get: jest.fn(() => ({ depositTokenFees: tokenFees })) };
    // 25 gwei: Arc's gas price on both tiers on 2026-11-18 (base 20 + tip 5).
    const rpc = { gasPrice: jest.fn().mockResolvedValue(25_000_000_000n) };
    const relayer = { isEnabled: () => true, address: () => RELAYER };
    return {
      factory: new EvmDepositAddressFactory(
        config as never,
        rpc as never,
        relayer as never,
      ),
      config,
      rpc,
    };
  }

  it('prices a USDC deposit from Arc’s gas price, in USDC’s 6 decimals', async () => {
    const { factory, config, rpc } = arc();
    const terms = await factory.mint('arc', 'testnet', DEST, {
      address: USDC,
      decimals: 6,
    });
    // 520k gas × 25 gwei × 1.25 = 0.01625 USDC (16,250 micro-USDC); gas is
    // paid in USDC, so the forward's cost is a price this service knows.
    expect(terms.fee).toBe(16_250n);
    expect(EvmDepositAddressFactory.displayFee(terms.fee, 6)).toBe('0.01625');
    expect(rpc.gasPrice).toHaveBeenCalledWith('arc', 'testnet');
    expect(config.get).toHaveBeenCalledWith('arc', { infer: true });
    expect(terms.token).toBe(USDC);
  });

  it('rounds a sub-micro gas fee up, never down', async () => {
    const { factory, rpc } = arc();
    rpc.gasPrice.mockResolvedValue(1n);
    const terms = await factory.mint('arc', 'public', DEST, {
      address: USDC,
      decimals: 6,
    });
    expect(terms.fee).toBe(1n);
  });

  it('takes ARC_DEPOSIT_TOKEN_FEES over the gas price, and charges EURC only what is configured', async () => {
    const configured = await arc({ [USDC]: '0.02' }).factory.mint(
      'arc',
      'public',
      DEST,
      { address: USDC, decimals: 6 },
    );
    expect(configured.fee).toBe(20_000n);

    const { factory, rpc } = arc();
    const eurc = await factory.mint('arc', 'testnet', DEST, {
      address: EURC,
      decimals: 6,
    });
    expect(eurc.fee).toBe(0n);
    expect(rpc.gasPrice).not.toHaveBeenCalled();
  });

  it('mints the CREATE2 address of a USDC forwarder, as on Monad', async () => {
    const terms = await arc().factory.mint('arc', 'public', DEST, {
      address: USDC,
      decimals: 6,
    });
    expect(terms.address).toBe(
      depositAddress(
        terms.salt,
        forwarderInitCode({
          destination: DEST,
          token: USDC,
          relayer: RELAYER,
          fee: terms.fee,
        }),
      ),
    );
  });
});
