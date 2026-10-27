import { assertZkPaymentsConfigConsistent } from '@/config/zk-payments-env';

const TESTNET_SET = {
  ZK_PAYMENTS_TESTNET_TOKEN:
    'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
  ZK_PAYMENTS_TESTNET_AUDITOR_REGISTRY:
    'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ',
  ZK_PAYMENTS_TESTNET_VERIFIER:
    'CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3',
  ZK_PAYMENTS_TESTNET_AUDITOR_SECRET: '0f'.repeat(32),
  ZK_PAYMENTS_TESTNET_FEE_ACCOUNT:
    'GACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKG7N',
  ZK_PAYMENTS_TESTNET_DEPLOYED_LEDGER: '5387137',
};

const mainnetSet = (over: Record<string, string> = {}) =>
  Object.fromEntries(
    Object.entries({ ...TESTNET_SET, ...over }).map(([k, v]) => [
      k.replace('TESTNET', 'MAINNET'),
      v,
    ]),
  );

describe('assertZkPaymentsConfigConsistent', () => {
  it('boots with no private payments configured at all', () => {
    expect(() => assertZkPaymentsConfigConsistent({})).not.toThrow();
  });

  it('boots with a complete testnet set, the RPC defaulting to SDF', () => {
    expect(() => assertZkPaymentsConfigConsistent(TESTNET_SET)).not.toThrow();
  });

  it('accepts an RPC URL set alone (the feature stays off)', () => {
    expect(() =>
      assertZkPaymentsConfigConsistent({
        ZK_PAYMENTS_TESTNET_RPC_URL: 'https://soroban-testnet.stellar.org',
      }),
    ).not.toThrow();
  });

  it('refuses a half-configured network, naming what is missing', () => {
    const { ZK_PAYMENTS_TESTNET_AUDITOR_SECRET: _s, ...withoutSecret } =
      TESTNET_SET;
    expect(() => assertZkPaymentsConfigConsistent(withoutSecret)).toThrow(
      /ZK_PAYMENTS_TESTNET_AUDITOR_SECRET is missing/,
    );
  });

  it.each([
    [
      'ZK_PAYMENTS_TESTNET_TOKEN',
      'GACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKG7N',
      /contract address/,
    ],
    ['ZK_PAYMENTS_TESTNET_VERIFIER', 'not-a-contract', /contract address/],
    [
      'ZK_PAYMENTS_TESTNET_FEE_ACCOUNT',
      'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
      /account address/,
    ],
    ['ZK_PAYMENTS_TESTNET_AUDITOR_SECRET', 'abc', /64 hex/],
    ['ZK_PAYMENTS_TESTNET_AUDITOR_SECRET', '0'.repeat(64), /not zero/],
    ['ZK_PAYMENTS_TESTNET_DEPLOYED_LEDGER', 'soon', /ledger sequence/],
    ['ZK_PAYMENTS_TESTNET_RPC_URL', 'ftp://rpc.example', /http\(s\) URL/],
  ])('refuses %s=%s', (name, value, error) => {
    expect(() =>
      assertZkPaymentsConfigConsistent({ ...TESTNET_SET, [name]: value }),
    ).toThrow(error);
  });

  it('requires an RPC URL on mainnet, which has no public default', () => {
    expect(() => assertZkPaymentsConfigConsistent(mainnetSet())).toThrow(
      /ZK_PAYMENTS_MAINNET_RPC_URL is required/,
    );
    expect(() =>
      assertZkPaymentsConfigConsistent(
        mainnetSet({ ZK_PAYMENTS_TESTNET_RPC_URL: 'https://rpc.example.com' }),
      ),
    ).not.toThrow();
  });
});
