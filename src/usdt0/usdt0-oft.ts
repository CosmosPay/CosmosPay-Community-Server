import { nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  USDT0_DECIMAL_CONVERSION_RATE,
  USDT0_NATIVE_FEE_BUFFER_BPS,
} from '@/usdt0/usdt0.constants';

/**
 * The OFT's Soroban interface, as plain data both ways. Pure, so a spec reaches
 * every encoding rule without an RPC. The interface, from the deployed
 * contract's spec:
 *
 *   quote_oft(from, send_param) -> (OFTLimit, Vec<OFTFeeDetail>, OFTReceipt)
 *   quote_send(from, send_param, pay_in_zro) -> MessagingFee
 *   send(from, send_param, fee, refund_address) -> (MessagingReceipt, OFTReceipt)
 *
 * A Rust struct is an `ScMap` whose keys are symbols in alphabetical order (the
 * host refuses any other order), a `BytesN<32>` is a 32-byte `ScBytes`, and
 * every amount is an `i128` in the SAC's 7 decimals ("local decimals", `_ld`).
 */

/** `SendParam`, minus the fields this service always leaves empty. */
export interface SendParamInput {
  /** The destination network's LayerZero endpoint id. */
  dstEid: number;
  /** The EVM recipient, 0x + 40 hex. */
  recipient: string;
  /** In stroops of USDT0. */
  amountLd: bigint;
  /** The on-chain floor: `send` fails if less would arrive. In stroops. */
  minAmountLd: bigint;
}

/** What `quote_oft` answers: the OFT's limits, its fees and the receipt. */
export interface OftQuote {
  minAmountLd: bigint;
  maxAmountLd: bigint;
  fees: { description: string; feeAmountLd: bigint }[];
  /** What the OFT takes from the sender: the amount without its dust. */
  amountSentLd: bigint;
  /** What arrives on the destination network. */
  amountReceivedLd: bigint;
}

/** LayerZero's messaging fee, in stroops of XLM (and of ZRO, never used here). */
export interface MessagingFee {
  nativeFee: bigint;
  zroFee: bigint;
}

/** What a landed `send` returned. */
export interface SendReceipt {
  /** LayerZero's message id, 0x + 64 lowercase hex: what LayerZero Scan indexes. */
  guid: string;
  nonce: bigint;
  nativeFee: bigint;
  amountSentLd: bigint;
  amountReceivedLd: bigint;
}

/**
 * An EVM address as LayerZero carries every recipient: 32 bytes, the 20 of the
 * address right-aligned behind 12 zero bytes. Throws on anything that is not
 * 0x + 40 hex: this is the field that decides where the money goes.
 */
export function evmAddressToBytes32(address: string): Buffer {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new RangeError(`Not an EVM address: ${address}`);
  }
  return Buffer.concat([
    Buffer.alloc(12),
    Buffer.from(address.slice(2), 'hex'),
  ]);
}

/** The amount the OFT can carry: `amount` rounded down to its shared decimals. */
export function withoutDust(amountLd: bigint): bigint {
  return amountLd - (amountLd % USDT0_DECIMAL_CONVERSION_RATE);
}

/**
 * The `native_fee` this service offers `send`: the quote plus
 * {@link USDT0_NATIVE_FEE_BUFFER_BPS}, rounded up. The endpoint refunds what it
 * does not charge to `refund_address` in the same transaction.
 */
export function withFeeBuffer(nativeFee: bigint): bigint {
  const buffer = (nativeFee * USDT0_NATIVE_FEE_BUFFER_BPS + 9_999n) / 10_000n;
  return nativeFee + buffer;
}

/** `struct SendParam`, keys in the order the host requires. */
export function sendParamScVal(param: SendParamInput): xdr.ScVal {
  return struct({
    amount_ld: i128(param.amountLd),
    compose_msg: xdr.ScVal.scvBytes(Buffer.alloc(0)),
    dst_eid: xdr.ScVal.scvU32(param.dstEid),
    extra_options: xdr.ScVal.scvBytes(Buffer.alloc(0)),
    min_amount_ld: i128(param.minAmountLd),
    oft_cmd: xdr.ScVal.scvBytes(Buffer.alloc(0)),
    to: xdr.ScVal.scvBytes(evmAddressToBytes32(param.recipient)),
  });
}

/** `struct MessagingFee`. */
export function messagingFeeScVal(fee: MessagingFee): xdr.ScVal {
  return struct({ native_fee: i128(fee.nativeFee), zro_fee: i128(fee.zroFee) });
}

/** `quote_oft`'s return value. Throws on a shape the contract does not return. */
export function parseOftQuote(retval: xdr.ScVal): OftQuote {
  const value = scValToNative(retval) as unknown;
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError('quote_oft did not return (limit, fees, receipt)');
  }
  const [limit, fees, receipt] = value as [unknown, unknown, unknown];
  if (!Array.isArray(fees)) {
    throw new TypeError('quote_oft returned no fee list');
  }
  return {
    minAmountLd: bigintField(limit, 'min_amount_ld'),
    maxAmountLd: bigintField(limit, 'max_amount_ld'),
    fees: fees.map((fee: unknown) => ({
      description: Buffer.from(bytesField(fee, 'description')).toString('utf8'),
      feeAmountLd: bigintField(fee, 'fee_amount_ld'),
    })),
    amountSentLd: bigintField(receipt, 'amount_sent_ld'),
    amountReceivedLd: bigintField(receipt, 'amount_received_ld'),
  };
}

/** `quote_send`'s return value. */
export function parseMessagingFee(retval: xdr.ScVal): MessagingFee {
  const value = scValToNative(retval) as unknown;
  return {
    nativeFee: bigintField(value, 'native_fee'),
    zroFee: bigintField(value, 'zro_fee'),
  };
}

/** `send`'s return value, `(MessagingReceipt, OFTReceipt)`. */
export function parseSendReceipt(retval: xdr.ScVal): SendReceipt {
  const value = scValToNative(retval) as unknown;
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError('send did not return (MessagingReceipt, OFTReceipt)');
  }
  const [messaging, oft] = value as [unknown, unknown];
  const guid = bytesField(messaging, 'guid');
  if (guid.length !== 32) {
    throw new TypeError('send returned a guid that is not 32 bytes');
  }
  const fee = (messaging as Record<string, unknown>).fee;
  return {
    guid: `0x${Buffer.from(guid).toString('hex')}`,
    nonce: bigintField(messaging, 'nonce'),
    nativeFee: bigintField(fee, 'native_fee'),
    amountSentLd: bigintField(oft, 'amount_sent_ld'),
    amountReceivedLd: bigintField(oft, 'amount_received_ld'),
  };
}

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

function i128(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: 'i128' });
}

function bigintField(obj: unknown, key: string): bigint {
  const value =
    obj && typeof obj === 'object'
      ? (obj as Record<string, unknown>)[key]
      : undefined;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) {
    return BigInt(value);
  }
  throw new TypeError(`expected an integer at ${key}`);
}

function bytesField(obj: unknown, key: string): Uint8Array {
  const value =
    obj && typeof obj === 'object'
      ? (obj as Record<string, unknown>)[key]
      : undefined;
  if (value instanceof Uint8Array) return value;
  throw new TypeError(`expected bytes at ${key}`);
}
