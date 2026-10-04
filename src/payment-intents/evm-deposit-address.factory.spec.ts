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
