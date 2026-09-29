import {
  resolveBlindpayEnvironment,
  storedBlindpayEnvironment,
} from '@/blindpay/blindpay-environment';

describe('storedBlindpayEnvironment', () => {
  it('accepts the two values rows are written with', () => {
    expect(storedBlindpayEnvironment('prod')).toBe('prod');
    expect(storedBlindpayEnvironment('dev')).toBe('dev');
  });

  it('refuses anything else rather than guessing an instance', () => {
    expect(() => storedBlindpayEnvironment('production')).toThrow(
      /Unknown BlindPay environment/,
    );
  });
});

describe('resolveBlindpayEnvironment', () => {
  const configOn = (network: 'public' | 'testnet') =>
    ({ get: () => ({ network }) }) as any;
  const consumer = (environment: 'dev' | 'prod' | null) =>
    ({ username: 'cosmos_u1', environment }) as any;

  it("follows the key's environment whatever the configured network", () => {
    // A dev key on a mainnet-default deployment still must not reach the
    // production instance.
    expect(
      resolveBlindpayEnvironment(configOn('public'), consumer('dev')),
    ).toBe('dev');
    expect(
      resolveBlindpayEnvironment(configOn('testnet'), consumer('prod')),
    ).toBe('prod');
  });

  it('falls back with the configured Stellar network when no environment is forwarded', () => {
    expect(resolveBlindpayEnvironment(configOn('public'), consumer(null))).toBe(
      'prod',
    );
    expect(
      resolveBlindpayEnvironment(configOn('testnet'), consumer(null)),
    ).toBe('dev');
  });
});
