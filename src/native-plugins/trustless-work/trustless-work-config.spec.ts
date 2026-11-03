import { Keypair, StrKey } from '@stellar/stellar-sdk';
import type {
  AppConfig,
  TrustlessWorkNetworkConfig,
} from '@/config/configuration';
import { assertTrustlessWorkConfigConsistent } from '@/native-plugins/trustless-work/trustless-work-config';

const empty: TrustlessWorkNetworkConfig = {
  apiKey: '',
  baseUrl: 'https://dev.api.trustlesswork.com',
  platformSecret: '',
  resolverSecret: '',
  opsResolver: '',
  deployerContract: '',
  contractWasmHash: '',
};

const config = (
  testnet: Partial<TrustlessWorkNetworkConfig>,
): AppConfig['trustlessWork'] => ({
  networks: { testnet: { ...empty, ...testnet }, public: empty },
  platformFeeBps: 165,
  timeoutMs: 30_000,
  maxFeeStroops: 20_000_000,
});

const platform = Keypair.random();
const resolver = Keypair.random();
const ops = Keypair.random().publicKey();
const whole = {
  apiKey: 'tw_key',
  platformSecret: platform.secret(),
  resolverSecret: resolver.secret(),
  opsResolver: ops,
};

describe('assertTrustlessWorkConfigConsistent', () => {
  it('accepts nothing set, and a whole set of three distinct accounts', () => {
    expect(() => assertTrustlessWorkConfigConsistent(config({}))).not.toThrow();
    expect(() =>
      assertTrustlessWorkConfigConsistent(
        config({
          ...whole,
          deployerContract: StrKey.encodeContract(Buffer.alloc(32, 1)),
          contractWasmHash: 'ab'.repeat(32),
        }),
      ),
    ).not.toThrow();
  });

  it('requires both deploy pins on mainnet, and neither on testnet', () => {
    const pins = {
      deployerContract: StrKey.encodeContract(Buffer.alloc(32, 1)),
      contractWasmHash: 'ab'.repeat(32),
    };
    const onMainnet = (
      cfg: Partial<TrustlessWorkNetworkConfig>,
    ): AppConfig['trustlessWork'] => ({
      ...config({}),
      networks: { testnet: empty, public: { ...empty, ...cfg } },
    });
    expect(() => assertTrustlessWorkConfigConsistent(onMainnet(whole))).toThrow(
      /TRUSTLESS_WORK_DEPLOYER_CONTRACT_MAINNET and .* are required/,
    );
    expect(() =>
      assertTrustlessWorkConfigConsistent(
        onMainnet({ ...whole, deployerContract: pins.deployerContract }),
      ),
    ).toThrow(/are required/);
    expect(() =>
      assertTrustlessWorkConfigConsistent(onMainnet({ ...whole, ...pins })),
    ).not.toThrow();
    expect(() =>
      assertTrustlessWorkConfigConsistent(config(whole)),
    ).not.toThrow();
  });

  it('refuses an API key without a platform key, and the other way round', () => {
    expect(() =>
      assertTrustlessWorkConfigConsistent(config({ apiKey: 'k' })),
    ).toThrow(/TRUSTLESS_WORK_PLATFORM_SECRET_TESTNET is required/);
    expect(() =>
      assertTrustlessWorkConfigConsistent(
        config({ platformSecret: platform.secret() }),
      ),
    ).toThrow(/TRUSTLESS_WORK_API_KEY_TESTNET is required/);
  });

  it('refuses values that are not what they claim to be', () => {
    expect(() =>
      assertTrustlessWorkConfigConsistent(
        config({ ...whole, platformSecret: platform.publicKey() }),
      ),
    ).toThrow(/PLATFORM_SECRET_TESTNET must be a Stellar secret seed/);
    expect(() =>
      assertTrustlessWorkConfigConsistent(
        config({ ...whole, opsResolver: resolver.secret() }),
      ),
    ).toThrow(/OPS_RESOLVER_TESTNET must be a Stellar account address/);
    expect(() =>
      assertTrustlessWorkConfigConsistent(
        config({ ...whole, deployerContract: ops }),
      ),
    ).toThrow(/DEPLOYER_CONTRACT_TESTNET must be a contract address/);
    expect(() =>
      assertTrustlessWorkConfigConsistent(
        config({ ...whole, contractWasmHash: 'xyz' }),
      ),
    ).toThrow(/CONTRACT_WASM_HASH_TESTNET/);
  });

  it('refuses one account in two roles', () => {
    expect(() =>
      assertTrustlessWorkConfigConsistent(
        config({ ...whole, resolverSecret: platform.secret() }),
      ),
    ).toThrow(/are the same account/);
    expect(() =>
      assertTrustlessWorkConfigConsistent(
        config({ ...whole, opsResolver: resolver.publicKey() }),
      ),
    ).toThrow(/are the same account/);
  });
});
