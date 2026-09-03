import {
  asId,
  asPollarWallet,
  toPollarWalletEntity,
  walletAddress,
} from '@/pollar/pollar.util';

const ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe('asId', () => {
  it('accepts a non-blank string and rejects everything else', () => {
    expect(asId('usr_1')).toBe('usr_1');
    expect(asId('   ')).toBeNull();
    expect(asId(42)).toBeNull();
    expect(asId(null)).toBeNull();
    expect(asId({ id: 'x' })).toBeNull();
  });
});

describe('walletAddress', () => {
  it('prefers `address`, which every wallet type carries', () => {
    expect(
      walletAddress({ type: 'internal', address: ADDRESS, publicKey: 'other' }),
    ).toBe(ADDRESS);
  });

  it('falls back to `publicKey` for a classic account', () => {
    expect(walletAddress({ type: 'internal', publicKey: ADDRESS })).toBe(
      ADDRESS,
    );
  });

  it('is null when the wallet has neither, or is absent', () => {
    expect(walletAddress({ type: 'internal' })).toBeNull();
    expect(walletAddress(undefined)).toBeNull();
  });
});

describe('toPollarWalletEntity', () => {
  it('renames the fields the API publishes', () => {
    expect(
      toPollarWalletEntity({
        type: 'internal',
        address: ADDRESS,
        chain: 'STELLAR',
        existsOnStellar: false,
        fundingMode: 'DEFERRED',
        network: 'testnet',
      }),
    ).toEqual({
      type: 'internal',
      address: ADDRESS,
      chain: 'STELLAR',
      exists_on_stellar: false,
      funding_mode: 'DEFERRED',
      network: 'testnet',
    });
  });

  it('keeps a smart wallet with no publicKey addressable', () => {
    expect(
      toPollarWalletEntity({ type: 'smart', address: 'CA5Z...' }).address,
    ).toBe('CA5Z...');
  });
});

describe('asPollarWallet', () => {
  it('reads the undocumented blob the user routes return', () => {
    expect(
      asPollarWallet({
        type: 'internal',
        publicKey: ADDRESS,
        existsOnStellar: true,
        network: 'testnet',
      }),
    ).toEqual({
      type: 'internal',
      address: ADDRESS,
      chain: undefined,
      existsOnStellar: true,
      network: 'testnet',
    });
  });

  it('defaults an absent type rather than emitting undefined', () => {
    expect(asPollarWallet({ address: ADDRESS })?.type).toBe('internal');
  });

  it('returns null when there is no address to build on', () => {
    // Half a wallet is worse than none: it would publish a wallet object the
    // caller cannot do anything with.
    expect(asPollarWallet({ type: 'internal' })).toBeNull();
    expect(asPollarWallet({ address: '  ' })).toBeNull();
  });

  it('returns null for anything that is not an object', () => {
    expect(asPollarWallet(undefined)).toBeNull();
    expect(asPollarWallet(null)).toBeNull();
    expect(asPollarWallet('GA5Z...')).toBeNull();
  });

  it('drops a non-boolean existsOnStellar instead of coercing it', () => {
    // Pollar does not publish this shape, so a drifted value must not become a
    // confident `true`.
    expect(
      asPollarWallet({ address: ADDRESS, existsOnStellar: 'yes' }),
    ).not.toHaveProperty('existsOnStellar');
  });
});
