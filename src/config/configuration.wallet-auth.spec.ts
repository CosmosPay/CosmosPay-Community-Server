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
    expect(walletAuth.signersHorizonUrl).toBe(DEFAULT_HORIZON.testnet);
    expect(walletAuth.sponsor.horizonUrl).toBe(DEFAULT_HORIZON.testnet);
    expect(walletAuth.sponsor.networkPassphrase).toBe(
      NETWORK_PASSPHRASE_TESTNET,
    );
  });

  it('reads signers from the public ledger when the deployment is on public', () => {
    process.env.STELLAR_NETWORK = 'public';
    const { walletAuth } = configuration();
    expect(walletAuth.signersHorizonUrl).toBe(DEFAULT_HORIZON.public);
    expect(walletAuth.sponsor.horizonUrl).toBe(DEFAULT_HORIZON.public);
    expect(walletAuth.sponsor.networkPassphrase).toBe(
      NETWORK_PASSPHRASE_PUBLIC,
    );
  });

  it('uses the operator’s own Horizon for that network', () => {
    process.env.STELLAR_NETWORK = 'public';
    process.env.STELLAR_HORIZON_URL_PUBLIC = 'https://horizon.example.org';
    expect(configuration().walletAuth.signersHorizonUrl).toBe(
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
    expect(walletAuth.signersHorizonUrl).toBe('https://horizon.stellar.org');
    expect(walletAuth.sponsor.networkPassphrase).toBe(
      NETWORK_PASSPHRASE_PUBLIC,
    );
  });
});
