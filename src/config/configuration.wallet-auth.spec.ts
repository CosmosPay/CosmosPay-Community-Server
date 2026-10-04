import configuration from '@/config/configuration';
import {
  DEFAULT_HORIZON,
  NETWORK_PASSPHRASE_PUBLIC,
  NETWORK_PASSPHRASE_TESTNET,
} from '@/config/config.constants';

/**
 * The ledger a recovered wallet's signers are read from. A testnet account looked
 * up on mainnet Horizon is a 404, and the sign-in of every recovered wallet fails
 * with `wallet_signature_invalid` — so the default follows `STELLAR_NETWORK`.
 */
describe('wallet sign-in Stellar defaults', () => {
  const VARS = [
    'STELLAR_NETWORK',
    'STELLAR_HORIZON_URL_PUBLIC',
    'STELLAR_HORIZON_URL_TESTNET',
    'WALLET_AUTH_SIGNERS_HORIZON_URL',
    'WALLET_RECOVERY_SPONSOR_NETWORK_PASSPHRASE',
    'WALLET_RECOVERY_SPONSOR_HORIZON_URL',
    'WALLET_RECOVERY_SPONSOR_NETWORKS',
    'RECOVERY_NETWORK_PASSPHRASE',
    'RECOVERY_HORIZON_URL',
    'RECOVERY_NETWORKS',
    'RECOVERY_HORIZON_URL_TESTNET',
  ];
  const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  beforeEach(() => VARS.forEach((v) => delete process.env[v]));
  afterEach(() =>
    VARS.forEach((v) =>
      saved[v] === undefined
        ? delete process.env[v]
        : (process.env[v] = saved[v]),
    ),
  );

  it('reads signers from the testnet ledger when the deployment is on testnet', () => {
    process.env.STELLAR_NETWORK = 'testnet';
    const { walletAuth } = configuration();
    expect(walletAuth.signersHorizonUrls[walletAuth.signersNetwork]).toBe(
      DEFAULT_HORIZON.testnet,
    );
    expect(walletAuth.sponsor.horizonUrl).toBe(DEFAULT_HORIZON.testnet);
    expect(walletAuth.sponsor.networkPassphrase).toBe(
      NETWORK_PASSPHRASE_TESTNET,
    );
  });

  it('reads signers from the public ledger when the deployment is on public', () => {
    process.env.STELLAR_NETWORK = 'public';
    const { walletAuth } = configuration();
    expect(walletAuth.signersHorizonUrls[walletAuth.signersNetwork]).toBe(
      DEFAULT_HORIZON.public,
    );
    expect(walletAuth.sponsor.horizonUrl).toBe(DEFAULT_HORIZON.public);
    expect(walletAuth.sponsor.networkPassphrase).toBe(
      NETWORK_PASSPHRASE_PUBLIC,
    );
  });

  it('uses the operator’s own Horizon for that network', () => {
    process.env.STELLAR_NETWORK = 'public';
    process.env.STELLAR_HORIZON_URL_PUBLIC = 'https://horizon.example.org';
    const { walletAuth } = configuration();
    expect(walletAuth.signersHorizonUrls[walletAuth.signersNetwork]).toBe(
      'https://horizon.example.org',
    );
  });

  it('keeps an explicit setting over the network’s default', () => {
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.WALLET_AUTH_SIGNERS_HORIZON_URL =
      'https://horizon.stellar.org/';
    process.env.WALLET_RECOVERY_SPONSOR_NETWORK_PASSPHRASE =
      NETWORK_PASSPHRASE_PUBLIC;
    const { walletAuth } = configuration();
    expect(walletAuth.signersHorizonUrls[walletAuth.signersNetwork]).toBe(
      'https://horizon.stellar.org',
    );
    expect(walletAuth.sponsor.networkPassphrase).toBe(
      NETWORK_PASSPHRASE_PUBLIC,
    );
  });

  /* A re-key lands on ONE ledger; the wallet says which, and only these two
     operator Horizons can be asked — never a URL from the request. */
  it('knows a Horizon for each ledger, whatever the default', () => {
    process.env.STELLAR_NETWORK = 'public';
    const { walletAuth } = configuration();
    expect(walletAuth.signersNetwork).toBe('public');
    expect(walletAuth.signersHorizonUrls).toEqual({
      public: DEFAULT_HORIZON.public,
      testnet: DEFAULT_HORIZON.testnet,
    });
  });

  it('sponsors on every listed ledger with the same key, and only those', () => {
    process.env.STELLAR_NETWORK = 'public';
    expect(Object.keys(configuration().walletAuth.sponsor.networks)).toEqual([
      'public',
    ]);
    process.env.WALLET_RECOVERY_SPONSOR_NETWORKS = 'testnet';
    expect(configuration().walletAuth.sponsor.networks).toEqual({
      public: {
        networkPassphrase: NETWORK_PASSPHRASE_PUBLIC,
        horizonUrl: DEFAULT_HORIZON.public,
      },
      testnet: {
        networkPassphrase: NETWORK_PASSPHRASE_TESTNET,
        horizonUrl: DEFAULT_HORIZON.testnet,
      },
    });
  });
});

/** One recovery server, every ledger the operator lists. */
describe('recovery server ledgers', () => {
  const VARS = [
    'RECOVERY_NETWORK_PASSPHRASE',
    'RECOVERY_HORIZON_URL',
    'RECOVERY_NETWORKS',
    'RECOVERY_HORIZON_URL_PUBLIC',
    'RECOVERY_HORIZON_URL_TESTNET',
  ];
  const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  beforeEach(() => VARS.forEach((v) => delete process.env[v]));
  afterEach(() =>
    VARS.forEach((v) =>
      saved[v] === undefined
        ? delete process.env[v]
        : (process.env[v] = saved[v]),
    ),
  );

  it('serves only its default ledger unless told otherwise', () => {
    const { recovery } = configuration();
    expect(recovery.networkPassphrase).toBe(NETWORK_PASSPHRASE_PUBLIC);
    expect(Object.keys(recovery.networks)).toEqual(['public']);
  });

  it('adds the listed ledgers, each on its own Horizon', () => {
    process.env.RECOVERY_NETWORKS = 'public,testnet';
    process.env.RECOVERY_HORIZON_URL = 'https://horizon.example.org/';
    process.env.RECOVERY_HORIZON_URL_TESTNET = 'https://testnet.example.org';
    expect(configuration().recovery.networks).toEqual({
      public: {
        networkPassphrase: NETWORK_PASSPHRASE_PUBLIC,
        horizonUrl: 'https://horizon.example.org',
      },
      testnet: {
        networkPassphrase: NETWORK_PASSPHRASE_TESTNET,
        horizonUrl: 'https://testnet.example.org',
      },
    });
  });

  it('keeps a testnet default reachable by name too', () => {
    process.env.RECOVERY_NETWORK_PASSPHRASE = NETWORK_PASSPHRASE_TESTNET;
    process.env.RECOVERY_HORIZON_URL = DEFAULT_HORIZON.testnet;
    process.env.RECOVERY_NETWORKS = 'public';
    const { networks } = configuration().recovery;
    expect(networks.testnet?.horizonUrl).toBe(DEFAULT_HORIZON.testnet);
    expect(networks.public?.horizonUrl).toBe(DEFAULT_HORIZON.public);
  });
});
