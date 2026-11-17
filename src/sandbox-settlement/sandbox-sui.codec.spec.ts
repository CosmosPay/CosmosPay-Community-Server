import {
  normalizeSuiAddress,
  packSuiSigned,
  signSuiTransaction,
  suiAddressOfSecret,
  suiCoinTransferBcs,
  suiTransactionDigest,
  unpackSuiSigned,
  type SuiObjectRef,
} from '@/sandbox-settlement/sandbox-sui.codec';

/*
 * Every vector below was produced by the official SDK (@mysten/sui 1.45.2:
 * Ed25519Keypair.fromSecretKey, Transaction.build / getDigest /
 * signTransaction) for the same key and inputs, so these pin the hand-written
 * BCS to the encoding validators accept.
 */
const SECRET = Uint8Array.from(Buffer.alloc(32, 7));
const SENDER =
  '0xa0ccc8bcc83f6c628340134f8546a21e0618fd1aaa02432bba454c4a2c2233da';
const ONE_COIN = {
  bytes:
    '0000030100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
    'aaaaaaaaaa05000000000000002057656130738020e983aa1574d64dc413b3e0' +
    '97ce64b42bcdd9cfadf8538536e1000840787d01000000000020abababababab' +
    'abababababababababababababababababababababababababab020201000001' +
    '01010001010300000000010200a0ccc8bcc83f6c628340134f8546a21e0618fd' +
    '1aaa02432bba454c4a2c2233da01cccccccccccccccccccccccccccccccccccc' +
    'cccccccccccccccccccccccccccc090000000000000020857245eec901835e45' +
    '09ddeae267120ba8e6b79f247db0402ed804330d1b9c6fa0ccc8bcc83f6c6283' +
    '40134f8546a21e0618fd1aaa02432bba454c4a2c2233dae80300000000000000' +
    '2d31010000000000',
  digest: '6By1AZmMEdkKSf55gVF9qCfErrX7BLTaxpowUH3Qneoy',
  signature:
    'AC6/cZANKANKaZZasPmQmJMuWwAC83g7NZXhz2T9upi3Yi7lKztFRRNswKjtY2Ji18FFagHq/4cPlm4E9suVpwPqSmxj4pxSCr71UHsTLsX5lUd2rr6+e5JCHuppFEbSLA==',
};
const TWO_COIN = {
  bytes:
    '0000040100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
    'aaaaaaaaaa05000000000000002057656130738020e983aa1574d64dc413b3e0' +
    '97ce64b42bcdd9cfadf8538536e10100bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' +
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb351cdcdf0200000020876e062e72ac00' +
    '834445b5c572efda88f372248c97aa047a590fd08dbb2658dc000840787d0100' +
    '0000000020ababababababababababababababababababababababababababab' +
    'ababababab030301000001010100020100000101020001010301000000010300' +
    'a0ccc8bcc83f6c628340134f8546a21e0618fd1aaa02432bba454c4a2c2233da' +
    '01cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' +
    'cc090000000000000020857245eec901835e4509ddeae267120ba8e6b79f247d' +
    'b0402ed804330d1b9c6fa0ccc8bcc83f6c628340134f8546a21e0618fd1aaa02' +
    '432bba454c4a2c2233dae803000000000000002d31010000000000',
  digest: 'EaUejAHhFuNi85sAQcEc33rpohu6CGjqD6byKgS7BCjD',
  signature:
    'AB67x32e1JeKdtBF5XamWfBYOMMJyI3jsdWVveeaV8ue5Vv5SJjH2zoIH60weescbVRl+Gq/zR18IjP2GJGE+g7qSmxj4pxSCr71UHsTLsX5lUd2rr6+e5JCHuppFEbSLA==',
};

const ref = (byte: string, version: bigint, digest: string): SuiObjectRef => ({
  objectId: '0x' + byte.repeat(64),
  version,
  digest,
});
const COIN_A = ref('a', 5n, '6tA8ZbFcY9ULLRmYjq5yJ9kQ6dJXkUCfNVDuxM9KHzyE');
const COIN_B = ref(
  'b',
  12345678901n,
  'A7fM1xC6yX2Nn4aPgqvq2dbZpX3GSgWHVn5uTm8TjQ5h',
);
const GAS = ref('c', 9n, '9yvHgQnyBUtT4NBuG1oo6ziM4WNE7bUGBj1DhEcnHn3x');

function transfer(coins: SuiObjectRef[]) {
  return suiCoinTransferBcs({
    sender: SENDER,
    coins,
    recipient: '0x' + 'ab'.repeat(32),
    amount: 25_000_000n,
    gasPayment: [GAS],
    gasPrice: 1000n,
    gasBudget: 20_000_000n,
  });
}

describe('Sui codec', () => {
  it('derives the address of an ed25519 key as the SDK does', () => {
    expect(suiAddressOfSecret(SECRET)).toBe(SENDER);
  });

  it('encodes a one-coin transfer byte for byte, with its digest and signature', () => {
    const bytes = transfer([COIN_A]);
    expect(Buffer.from(bytes).toString('hex')).toBe(ONE_COIN.bytes);
    expect(suiTransactionDigest(bytes)).toBe(ONE_COIN.digest);
    expect(signSuiTransaction(bytes, SECRET)).toBe(ONE_COIN.signature);
  });

  it('merges several coins before the split, byte for byte', () => {
    const bytes = transfer([COIN_A, COIN_B]);
    expect(Buffer.from(bytes).toString('hex')).toBe(TWO_COIN.bytes);
    expect(suiTransactionDigest(bytes)).toBe(TWO_COIN.digest);
    expect(signSuiTransaction(bytes, SECRET)).toBe(TWO_COIN.signature);
  });

  it('refuses a transfer without coins or gas, and a malformed digest', () => {
    expect(() => transfer([])).toThrow(/at least one coin/);
    expect(() =>
      suiCoinTransferBcs({
        sender: SENDER,
        coins: [COIN_A],
        recipient: SENDER,
        amount: 1n,
        gasPayment: [],
        gasPrice: 1000n,
        gasBudget: 1n,
      }),
    ).toThrow(/gas coin/);
    expect(() => transfer([{ ...COIN_A, digest: 'abc' }])).toThrow(
      /object digest/,
    );
  });

  it('spells an address in 64 lowercase hex', () => {
    expect(normalizeSuiAddress('0x2')).toBe('0x' + '0'.repeat(63) + '2');
    expect(normalizeSuiAddress('0x' + 'AB'.repeat(32))).toBe(
      '0x' + 'ab'.repeat(32),
    );
    expect(() => normalizeSuiAddress('ab')).toThrow(/not a Sui address/);
  });

  it('packs the signed bytes so the same execution can be sent again', () => {
    const bytes = transfer([COIN_A]);
    const raw = packSuiSigned(bytes, ONE_COIN.signature);
    expect(unpackSuiSigned(raw)).toEqual({
      txBytes: Buffer.from(bytes).toString('base64'),
      signature: ONE_COIN.signature,
    });
    expect(() => unpackSuiSigned('a.b.c')).toThrow();
  });
});
