import { bytesToHex, hexToBytes } from '@/evm/rlp';
import {
  aptosAddressOfSecret,
  aptosFaTransferRaw,
  aptosLongAddress,
  aptosSigningMessage,
  aptosTransactionHash,
  decodeAptosSignedTransaction,
  signAptosTransaction,
} from '@/sandbox-settlement/sandbox-aptos.codec';

/**
 * Vectors from Aptos's own TypeScript SDK (@aptos-labs/ts-sdk 1.39.0, used
 * only to produce them): `Ed25519PrivateKey(0x11 * 32)`,
 * `RawTransaction(sender, 7, EntryFunction.build('0x1::primary_fungible_store',
 * 'transfer', ['0x1::fungible_asset::Metadata'], [USDC, 0xabc, U64(25000000)]),
 * 2000, 100, 1800000000, ChainId(2))`, `generateSigningMessageForTransaction`,
 * `SignedTransaction(raw, TransactionAuthenticatorEd25519)` and
 * `generateUserTransactionHash`.
 */
const SECRET = hexToBytes('0x' + '11'.repeat(32));
const SENDER =
  '0x147e4d3a5b10eaed2a93536e284c23096dfcea9ac61f0a8420e5d01fbd8f0ea8';
const USDC =
  '0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832';
const RAW =
  '147e4d3a5b10eaed2a93536e284c23096dfcea9ac61f0a8420e5d01fbd8f0ea8' +
  '0700000000000000' +
  '02' +
  '0000000000000000000000000000000000000000000000000000000000000001' +
  '167072696d6172795f66756e6769626c655f73746f7265' +
  '087472616e73666572' +
  '01070000000000000000000000000000000000000000000000000000000000000001' +
  '0e66756e6769626c655f6173736574084d6574616461746100' +
  '03' +
  '2069091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832' +
  '200000000000000000000000000000000000000000000000000000000000000abc' +
  '0840787d0100000000' +
  'd007000000000000' +
  '6400000000000000' +
  '00d2496b00000000' +
  '02';
const SIGNING_PREFIX =
  'b5e97db07fa0bd0e5598aa3643a9bc6f6693bddc1a9fec9e674a461eaa00b193';
const SIGNATURE =
  '08365977148a42c8e9e92730e6402a0b7012ec3665e024611a4b3305b7e3b03c' +
  '1dc9e38104d9f0abc4edc9bb56a39aaba6410d5e8d8ec92a46e455816b690205';
const PUBLIC_KEY =
  'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737';
const HASH =
  '0xdf9e2ff42dbd1d65d44a2f06f33edf8f3174beca7943a9434cd7cab1093f082e';

const TRANSFER = {
  sender: SENDER,
  sequenceNumber: 7n,
  metadata: USDC,
  recipient: '0xabc',
  amount: 25_000_000n,
  maxGasAmount: 2000n,
  gasUnitPrice: 100n,
  expirationSecs: 1_800_000_000n,
  chainId: 2,
};

describe('Aptos codec', () => {
  it('derives the account of an ed25519 key as the SDK does', () => {
    expect(aptosAddressOfSecret(SECRET)).toBe(SENDER);
  });

  it('pads a short address to its 32-byte spelling', () => {
    expect(aptosLongAddress('0xABC')).toBe('0x' + 'abc'.padStart(64, '0'));
    expect(() => aptosLongAddress('abc')).toThrow();
    expect(() => aptosLongAddress('0x' + '1'.repeat(65))).toThrow();
  });

  it('serializes the transfer, its signing message and its signed bytes as the SDK does', () => {
    const raw = aptosFaTransferRaw(TRANSFER);
    expect(bytesToHex(raw)).toBe('0x' + RAW);
    expect(bytesToHex(aptosSigningMessage(raw))).toBe(
      '0x' + SIGNING_PREFIX + RAW,
    );
    const signed = signAptosTransaction(raw, SECRET);
    expect(signed.raw).toBe(
      '0x' + RAW + '00' + '20' + PUBLIC_KEY + '40' + SIGNATURE,
    );
    expect(signed.hash).toBe(HASH);
    expect(aptosTransactionHash(hexToBytes(signed.raw))).toBe(HASH);
  });

  it('reads the sender, sequence, expiration and chain back from the signed bytes', () => {
    const signed = signAptosTransaction(aptosFaTransferRaw(TRANSFER), SECRET);
    expect(decodeAptosSignedTransaction(signed.raw)).toEqual({
      sender: SENDER,
      sequenceNumber: 7n,
      expirationSecs: 1_800_000_000n,
      chainId: 2,
      hash: HASH,
    });
    expect(() => decodeAptosSignedTransaction('0x' + RAW)).toThrow();
  });

  it('refuses a chain id or an amount BCS cannot carry', () => {
    expect(() => aptosFaTransferRaw({ ...TRANSFER, chainId: 256 })).toThrow();
    expect(() =>
      aptosFaTransferRaw({ ...TRANSFER, amount: 1n << 64n }),
    ).toThrow();
  });
});
