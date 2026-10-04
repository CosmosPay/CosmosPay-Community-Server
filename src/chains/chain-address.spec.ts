import { Keypair } from '@stellar/stellar-sdk';
import {
  CHAIN_ADDRESS_RULES,
  decodeBase58,
  encodeBase58,
  isAddressForChain,
  normalizeAddress,
  toChecksumAddress,
} from '@/chains/chain-address';
import { CHAINS } from '@/chains/chains.constants';

const STELLAR = 'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';
const SOLANA = 'So11111111111111111111111111111111111111112';
const MONAD = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

describe('base58', () => {
  it('round-trips bytes, leading zeros included', () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 3, 255]);
    expect(decodeBase58(encodeBase58(bytes))).toEqual(bytes);
  });

  it('decodes the system program to 32 zero bytes', () => {
    expect(decodeBase58('11111111111111111111111111111111')).toEqual(
      new Uint8Array(32),
    );
  });

  it('refuses characters outside the alphabet', () => {
    expect(decodeBase58('0OIl')).toBeNull();
    expect(decodeBase58('')).toBeNull();
  });

  it('spells a Stellar key’s raw bytes as the Solana address of the same key', () => {
    const kp = Keypair.random();
    const solana = encodeBase58(kp.rawPublicKey());
    expect(isAddressForChain('solana', solana)).toBe(true);
    expect(decodeBase58(solana)).toEqual(Uint8Array.from(kp.rawPublicKey()));
  });
});

describe('EIP-55', () => {
  // The reference vectors from the EIP.
  it.each([
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ])('checksums %s', (address) => {
    expect(toChecksumAddress(address.toLowerCase())).toBe(address);
    expect(toChecksumAddress(address.toUpperCase().replace('0X', '0x'))).toBe(
      address,
    );
  });
});

describe('CHAIN_ADDRESS_RULES', () => {
  const valid: Record<(typeof CHAINS)[number], string> = {
    stellar: STELLAR,
    solana: SOLANA,
    monad: MONAD,
  };

  it.each(CHAINS)('accepts %s’s own address and no other chain’s', (chain) => {
    for (const other of CHAINS) {
      expect(isAddressForChain(chain, valid[other])).toBe(other === chain);
    }
  });

  it('stores an EVM address in one spelling whatever case it arrived in', () => {
    expect(normalizeAddress('monad', MONAD.toLowerCase())).toBe(MONAD);
    expect(normalizeAddress('stellar', STELLAR)).toBe(STELLAR);
    expect(normalizeAddress('solana', SOLANA)).toBe(SOLANA);
  });

  it('names what each chain expects', () => {
    expect(CHAIN_ADDRESS_RULES.monad.expected).toMatch(/0x/);
  });
});
