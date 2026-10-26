import { nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  evmAddressToBytes32,
  messagingFeeScVal,
  parseMessagingFee,
  parseOftQuote,
  parseSendReceipt,
  sendParamScVal,
  withFeeBuffer,
  withoutDust,
} from '@/usdt0/usdt0-oft';

const RECIPIENT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

/** A struct as the host returns one: an ScMap with symbol keys, sorted. */
function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map(
        (key) =>
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol(key),
            val: fields[key],
          }),
      ),
  );
}
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });

describe('evmAddressToBytes32', () => {
  it('right-aligns the 20 bytes behind 12 zero bytes, as LayerZero carries a recipient', () => {
    const bytes = evmAddressToBytes32(RECIPIENT);
    expect(bytes).toHaveLength(32);
    expect(bytes.subarray(0, 12)).toEqual(Buffer.alloc(12));
    expect(bytes.subarray(12).toString('hex')).toBe(
      RECIPIENT.slice(2).toLowerCase(),
    );
  });

  it.each([
    '0x1234',
    'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    `0x${'g'.repeat(40)}`,
  ])('refuses %s', (address) => {
    expect(() => evmAddressToBytes32(address)).toThrow(RangeError);
  });
});

describe('sendParamScVal', () => {
  const param = {
    dstEid: 30101,
    recipient: RECIPIENT,
    amountLd: 125_000_000n,
    minAmountLd: 124_000_000n,
  };

  it('is a map whose keys are in the alphabetical order the host requires', () => {
    const scval = sendParamScVal(param);
    expect(scval.type).toBe('scvMap');
    const keys = (scval as unknown as { map: xdr.ScMapEntry[] }).map.map(
      (entry) => scValToNative(entry.key) as string,
    );
    expect(keys).toEqual([
      'amount_ld',
      'compose_msg',
      'dst_eid',
      'extra_options',
      'min_amount_ld',
      'oft_cmd',
      'to',
    ]);
  });

  it('carries the amounts as i128, the eid as u32, the padded recipient and empty bytes', () => {
    const native = scValToNative(sendParamScVal(param)) as Record<
      string,
      unknown
    >;
    expect(native.amount_ld).toBe(125_000_000n);
    expect(native.min_amount_ld).toBe(124_000_000n);
    expect(native.dst_eid).toBe(30101);
    expect(Buffer.from(native.to as Uint8Array).toString('hex')).toBe(
      `${'00'.repeat(12)}${RECIPIENT.slice(2).toLowerCase()}`,
    );
    for (const key of ['compose_msg', 'extra_options', 'oft_cmd']) {
      expect(native[key]).toHaveLength(0);
    }
  });

  it('encodes MessagingFee with native_fee before zro_fee', () => {
    const native = scValToNative(
      messagingFeeScVal({ nativeFee: 42_474_009n, zroFee: 0n }),
    );
    expect(native).toEqual({ native_fee: 42_474_009n, zro_fee: 0n });
  });
});

describe('dust and the fee buffer', () => {
  it.each([
    [100_000_001n, 100_000_000n],
    [100_000_000n, 100_000_000n],
    [10n, 10n],
    [9n, 0n],
    [1n, 0n],
  ])(
    'withoutDust(%s) is %s: the OFT shares 6 of the 7 decimals',
    (ld, sent) => {
      expect(withoutDust(ld)).toBe(sent);
    },
  );

  it('adds 20% to the quoted fee, rounded up', () => {
    // The mainnet quote to Ethereum on 2026-10-25: 3.5395007 XLM.
    expect(withFeeBuffer(35_395_007n)).toBe(42_474_009n);
    expect(withFeeBuffer(36_664_143n)).toBe(43_996_972n);
    expect(withFeeBuffer(10n)).toBe(12n);
    expect(withFeeBuffer(0n)).toBe(0n);
  });
});

describe('return values', () => {
  it('reads quote_oft: limits, fee details and receipt', () => {
    const retval = xdr.ScVal.scvVec([
      struct({
        max_amount_ld: i128(18_446_744_073_709_551_615n),
        min_amount_ld: i128(0n),
      }),
      xdr.ScVal.scvVec([
        struct({
          description: xdr.ScVal.scvBytes(Buffer.from('route fee')),
          fee_amount_ld: i128(1_000n),
        }),
      ]),
      struct({
        amount_received_ld: i128(99_999_000n),
        amount_sent_ld: i128(100_000_000n),
      }),
    ]);
    expect(parseOftQuote(retval)).toEqual({
      minAmountLd: 0n,
      maxAmountLd: 18_446_744_073_709_551_615n,
      fees: [{ description: 'route fee', feeAmountLd: 1_000n }],
      amountSentLd: 100_000_000n,
      amountReceivedLd: 99_999_000n,
    });
  });

  it('reads quote_send', () => {
    expect(
      parseMessagingFee(
        struct({ native_fee: i128(5_133_636n), zro_fee: i128(0n) }),
      ),
    ).toEqual({ nativeFee: 5_133_636n, zroFee: 0n });
  });

  it("reads send's guid as 0x + 64 lowercase hex, with the nonce and receipt", () => {
    const guid = Buffer.from(
      'de686e45b4a4ba7553cbe127943bc52035d10e508eaa5b4df5a8dc24c16e2aab',
      'hex',
    );
    const retval = xdr.ScVal.scvVec([
      struct({
        fee: struct({ native_fee: i128(36_664_143n), zro_fee: i128(0n) }),
        guid: xdr.ScVal.scvBytes(guid),
        nonce: nativeToScVal(30n, { type: 'u64' }),
      }),
      struct({
        amount_received_ld: i128(4_662_869_870n),
        amount_sent_ld: i128(4_662_869_870n),
      }),
    ]);
    expect(parseSendReceipt(retval)).toEqual({
      guid: '0xde686e45b4a4ba7553cbe127943bc52035d10e508eaa5b4df5a8dc24c16e2aab',
      nonce: 30n,
      nativeFee: 36_664_143n,
      amountSentLd: 4_662_869_870n,
      amountReceivedLd: 4_662_869_870n,
    });
  });

  it('refuses shapes the contract never returns', () => {
    expect(() => parseOftQuote(xdr.ScVal.scvVoid())).toThrow(TypeError);
    expect(() => parseMessagingFee(xdr.ScVal.scvU32(1))).toThrow(TypeError);
    expect(() =>
      parseSendReceipt(
        xdr.ScVal.scvVec([
          struct({
            fee: struct({ native_fee: i128(1n), zro_fee: i128(0n) }),
            guid: xdr.ScVal.scvBytes(Buffer.alloc(16)),
            nonce: nativeToScVal(1n, { type: 'u64' }),
          }),
          struct({ amount_received_ld: i128(1n), amount_sent_ld: i128(1n) }),
        ]),
      ),
    ).toThrow(/32 bytes/);
  });
});
