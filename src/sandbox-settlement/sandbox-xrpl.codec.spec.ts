import {
  encodeIouAmount,
  iouValueToUnits,
  signXrplTransaction,
  xrplAccountIdOf,
  xrplAddressOfAccountId,
  xrplAddressOfSecret,
  xrplLastLedgerSequence,
  xrplPublicKey,
} from '@/sandbox-settlement/sandbox-xrpl.codec';
import {
  XRPL_TEST_USDC_CURRENCY,
  XRPL_TEST_USDC_ISSUER,
} from '@/sandbox-settlement/sandbox-xrpl.constants';

/**
 * Every vector below was produced by the XRP Ledger's own libraries
 * (`ripple-keypairs` 2.x for the key, address and signature,
 * `ripple-binary-codec` 2.x for `encodeForSigning` / `encode`) from the same
 * inputs, on 2026-11-17.
 */
const SECRET = new Uint8Array(32).fill(1);
const ADDRESS = 'rK8ZsqAcfkNoFzJQhApwb8Do4GhJ1nFxiy';
const USDC = {
  currency: XRPL_TEST_USDC_CURRENCY,
  issuer: XRPL_TEST_USDC_ISSUER,
};
const hex = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString('hex').toUpperCase();

describe('XRP Ledger codec', () => {
  it('derives the ed25519 signing key and classic address', () => {
    expect(hex(xrplPublicKey(SECRET))).toBe(
      'ED8A88E3DD7409F195FD52DB2D3CBA5D72CA6709BF1D94121BF3748801B40F6F5C',
    );
    expect(xrplAddressOfSecret(SECRET)).toBe(ADDRESS);
  });

  it('round-trips classic addresses and refuses a bad checksum', () => {
    expect([...xrplAccountIdOf('rrrrrrrrrrrrrrrrrrrrBZbvji')]).toEqual([
      ...new Array<number>(19).fill(0),
      1,
    ]);
    expect(xrplAddressOfAccountId(xrplAccountIdOf(XRPL_TEST_USDC_ISSUER))).toBe(
      XRPL_TEST_USDC_ISSUER,
    );
    expect(() => xrplAccountIdOf('rK8ZsqAcfkNoFzJQhApwb8Do4GhJ1nFxiz')).toThrow(
      /checksum/,
    );
  });

  it('encodes issued-currency amounts as the ledger does', () => {
    const amount = (units: bigint) =>
      hex(encodeIouAmount({ ...USDC, units, decimals: 6 })).slice(0, 16);
    expect(amount(0n)).toBe('8000000000000000');
    expect(amount(1n)).toBe('D3038D7EA4C68000');
    expect(amount(1_000_000n)).toBe('D4838D7EA4C68000');
    expect(amount(25_000_000n)).toBe('D4C8E1BC9BF04000');
    expect(amount(9_999_999_999_999_999n)).toBe('D6E386F26FC0FFFF');
    expect(amount(1_000_000_000_000_000n)).toBe('D6C38D7EA4C68000');
    expect(
      hex(encodeIouAmount({ ...USDC, units: 1n, decimals: 6 })).slice(16),
    ).toBe(
      '5553444300000000000000000000000000000000B9645A1B12195C43D15A81EF0D1B14039FF60691',
    );
  });

  it('reads issued-currency values in base units, truncating dust', () => {
    expect(iouValueToUnits('25', 6)).toBe(25_000_000n);
    expect(iouValueToUnits('0.01', 6)).toBe(10_000n);
    expect(iouValueToUnits('2213152355.85', 6)).toBe(2_213_152_355_850_000n);
    expect(iouValueToUnits('9999999999999990e5', 6)).toBe(
      999_999_999_999_999_000_000_000_000n,
    );
    expect(iouValueToUnits('1e-7', 6)).toBe(0n);
    expect(iouValueToUnits('1.0000019', 6)).toBe(1_000_001n);
    expect(iouValueToUnits('-3.5', 6)).toBe(-3_500_000n);
    expect(() => iouValueToUnits('abc', 6)).toThrow();
  });

  it('signs a Payment byte for byte as the reference libraries do', () => {
    const signed = signXrplTransaction(
      {
        TransactionType: 'Payment',
        Flags: 0,
        Account: ADDRESS,
        Destination: 'rN7Td1t4N7xDW8ohKpcvX1WiACRq9R8Ven',
        DestinationTag: 4294967295,
        Amount: { ...USDC, units: 25_123_456n, decimals: 6 },
        Fee: 12n,
        Sequence: 7,
        LastLedgerSequence: 22392999,
      },
      SECRET,
    );
    expect(signed.blob).toBe(
      '120000220000000024000000072EFFFFFFFF201B0155B0A761D4C8ECF70B0A80005553444300000000000000000000000000000000B9645A1B12195C43D15A81EF0D1B14039FF6069168400000000000000C7321ED8A88E3DD7409F195FD52DB2D3CBA5D72CA6709BF1D94121BF3748801B40F6F5C7440B07057BD888B5EFAF74921E934DF4C9FCE407D10A8F0431ECAADCBE0E690F83DD4D8C3F0B18AEC9BE6D36E1511D77BBB255A5EEB906479BB078630B722309C038114CE0FBC4E7C8431C6829E5F3E06E91D7D3573F22E831493CB19C209E5A2F28432B3FABBD5995518B2CB5B',
    );
    expect(signed.hash).toBe(
      '2B50F1DD326803D47D8ED21CBCF2C95605D7402C1C7827948C06217D87A5D08B',
    );
    expect(xrplLastLedgerSequence(signed.blob)).toBe(22392999);
  });

  it('signs a TrustSet byte for byte as the reference libraries do', () => {
    const signed = signXrplTransaction(
      {
        TransactionType: 'TrustSet',
        Flags: 0,
        Account: ADDRESS,
        LimitAmount: { ...USDC, units: 1_000_000_000_000_000n, decimals: 6 },
        Fee: 12n,
        Sequence: 8,
        LastLedgerSequence: 22393000,
      },
      SECRET,
    );
    expect(signed.blob).toBe(
      '12001422000000002400000008201B0155B0A863D6C38D7EA4C680005553444300000000000000000000000000000000B9645A1B12195C43D15A81EF0D1B14039FF6069168400000000000000C7321ED8A88E3DD7409F195FD52DB2D3CBA5D72CA6709BF1D94121BF3748801B40F6F5C7440D2103AA184CAB5926CD1F38F2648B8AEA88B39EDCD558F04047E283F9F4D7A415362514138AC8B94825A9D0CABF3C71664DD48E72580275F1A8AA32F7827F70A8114CE0FBC4E7C8431C6829E5F3E06E91D7D3573F22E',
    );
    expect(signed.hash).toBe(
      'D877E954968BFC5C21A4ACEFFB1BCD015093C878C1AF1061D1F6E8354222C46C',
    );
    expect(xrplLastLedgerSequence(signed.blob)).toBe(22393000);
  });

  it('finds no LastLedgerSequence in what is not a sandbox blob', () => {
    expect(xrplLastLedgerSequence('zz')).toBeNull();
    expect(xrplLastLedgerSequence('1200002200000000')).toBeNull();
  });
});
