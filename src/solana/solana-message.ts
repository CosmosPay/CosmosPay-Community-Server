import { decodeBase58, encodeBase58 } from '@/chains/chain-address';
import type { SolanaInstruction } from '@/solana/solana-transaction-builder';

/**
 * A Solana transaction read whole (legacy or v0, address lookup tables
 * included) and written back, so instructions can be added to one an
 * aggregator built (a merchant fee beside a Jupiter swap) without a Solana SDK.
 *
 *   transaction = shortvec(n) · n × 64-byte signatures · message
 *   message     = [0x80 for v0] · header(3) · shortvec(keys) · keys · blockhash ·
 *                 shortvec(ix) · ix… · [v0: shortvec(lookups) · lookup…]
 *
 * Accounts are addressed by one index space: the static keys, then every
 * table's writable entries (tables in order), then every table's read-only
 * entries. Adding a static key shifts the indexes after it, which
 * {@link appendInstructions} rewrites in every instruction.
 */

export interface CompiledInstruction {
  programIdIndex: number;
  accounts: number[];
  data: Uint8Array;
}

/** One address lookup table a v0 message loads accounts from, by index. */
export interface LookupTableUse {
  account: string;
  writable: number[];
  readonly: number[];
}

export interface CompiledMessage {
  version: 'legacy' | 0;
  /** numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned. */
  header: [number, number, number];
  staticKeys: string[];
  recentBlockhash: string;
  instructions: CompiledInstruction[];
  lookups: LookupTableUse[];
}

export interface DecodedTransaction {
  signatures: Uint8Array[];
  message: CompiledMessage;
}

/** Solana's compact-u16. */
function readShortVec(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 3; i += 1) {
    if (at + i >= bytes.length) throw new Error('shortvec runs past the input');
    const byte = bytes[at + i];
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return [value, at + i + 1];
  }
  throw new Error('shortvec is longer than 3 bytes');
}

function shortVec(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

function key(base58: string): Uint8Array {
  const bytes = decodeBase58(base58);
  if (!bytes || bytes.length !== 32) {
    throw new Error(`"${base58}" is not a Solana address`);
  }
  return bytes;
}

export function decodeTransaction(bytes: Uint8Array): DecodedTransaction {
  const [count, afterCount] = readShortVec(bytes, 0);
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    signatures.push(
      bytes.slice(afterCount + i * 64, afterCount + (i + 1) * 64),
    );
  }
  const m = bytes.subarray(afterCount + count * 64);
  let at = 0;
  let version: 'legacy' | 0 = 'legacy';
  if (m[0] & 0x80) {
    if (m[0] !== 0x80) throw new Error('unsupported message version');
    version = 0;
    at = 1;
  }
  const header: [number, number, number] = [m[at], m[at + 1], m[at + 2]];
  at += 3;
  const [keyCount, keysAt] = readShortVec(m, at);
  at = keysAt;
  const staticKeys: string[] = [];
  for (let i = 0; i < keyCount; i += 1) {
    staticKeys.push(encodeBase58(m.subarray(at, at + 32)));
    at += 32;
  }
  const recentBlockhash = encodeBase58(m.subarray(at, at + 32));
  at += 32;
  const [ixCount, ixAt] = readShortVec(m, at);
  at = ixAt;
  const instructions: CompiledInstruction[] = [];
  for (let i = 0; i < ixCount; i += 1) {
    const programIdIndex = m[at++];
    const [n, accountsAt] = readShortVec(m, at);
    const accounts = [...m.subarray(accountsAt, accountsAt + n)];
    at = accountsAt + n;
    const [len, dataAt] = readShortVec(m, at);
    const data = m.slice(dataAt, dataAt + len);
    at = dataAt + len;
    instructions.push({ programIdIndex, accounts, data });
  }
  const lookups: LookupTableUse[] = [];
  if (version === 0) {
    const [lookupCount, lookupAt] = readShortVec(m, at);
    at = lookupAt;
    for (let i = 0; i < lookupCount; i += 1) {
      const account = encodeBase58(m.subarray(at, at + 32));
      at += 32;
      const [w, wAt] = readShortVec(m, at);
      const writable = [...m.subarray(wAt, wAt + w)];
      at = wAt + w;
      const [r, rAt] = readShortVec(m, at);
      const readonly = [...m.subarray(rAt, rAt + r)];
      at = rAt + r;
      lookups.push({ account, writable, readonly });
    }
  }
  if (at !== m.length) throw new Error('trailing bytes after the message');
  return {
    signatures,
    message: {
      version,
      header,
      staticKeys,
      recentBlockhash,
      instructions,
      lookups,
    },
  };
}

export function encodeMessage(message: CompiledMessage): Uint8Array {
  const out: number[] = [];
  if (message.version === 0) out.push(0x80);
  out.push(...message.header);
  out.push(...shortVec(message.staticKeys.length));
  for (const k of message.staticKeys) out.push(...key(k));
  out.push(...key(message.recentBlockhash));
  out.push(...shortVec(message.instructions.length));
  for (const ix of message.instructions) {
    out.push(ix.programIdIndex);
    out.push(...shortVec(ix.accounts.length), ...ix.accounts);
    out.push(...shortVec(ix.data.length), ...ix.data);
  }
  if (message.version === 0) {
    out.push(...shortVec(message.lookups.length));
    for (const l of message.lookups) {
      out.push(...key(l.account));
      out.push(...shortVec(l.writable.length), ...l.writable);
      out.push(...shortVec(l.readonly.length), ...l.readonly);
    }
  }
  return Uint8Array.from(out);
}

export function encodeTransaction(tx: DecodedTransaction): Uint8Array {
  const message = encodeMessage(tx.message);
  const out = new Uint8Array(
    shortVec(tx.signatures.length).length +
      tx.signatures.length * 64 +
      message.length,
  );
  const prefix = shortVec(tx.signatures.length);
  out.set(prefix, 0);
  tx.signatures.forEach((sig, i) => out.set(sig, prefix.length + i * 64));
  out.set(message, prefix.length + tx.signatures.length * 64);
  return out;
}

/** Every account the message can address, in index order, with its flags. */
export function messageAccounts(
  message: CompiledMessage,
  tables: ReadonlyMap<string, readonly string[]>,
): { pubkey: string; signer: boolean; writable: boolean }[] {
  const [signers, readonlySigned, readonlyUnsigned] = message.header;
  const n = message.staticKeys.length;
  const statics = message.staticKeys.map((pubkey, i) => ({
    pubkey,
    signer: i < signers,
    writable:
      i < signers ? i < signers - readonlySigned : i < n - readonlyUnsigned,
  }));
  const loaded = (kind: 'writable' | 'readonly') =>
    message.lookups.flatMap((l) => {
      const table = tables.get(l.account);
      if (!table) throw new Error(`lookup table ${l.account} was not loaded`);
      return l[kind].map((index) => {
        const pubkey = table[index];
        if (!pubkey)
          throw new Error(`lookup table ${l.account} has no entry ${index}`);
        return { pubkey, signer: false, writable: kind === 'writable' };
      });
    });
  return [...statics, ...loaded('writable'), ...loaded('readonly')];
}

/**
 * Adds `extra` to the end of `message`, reusing every account it already
 * addresses (statically or through a lookup table: Solana refuses an account
 * loaded twice) and adding the others as static keys, then re-indexing every
 * instruction. Refuses what cannot be added safely: a new signer, an account
 * that would have to become writable or a signer, a program only a lookup table
 * holds (programs must be static).
 */
export function appendInstructions(
  message: CompiledMessage,
  extra: SolanaInstruction[],
  tables: ReadonlyMap<string, readonly string[]>,
): CompiledMessage {
  const accounts = messageAccounts(message, tables);
  const n = message.staticKeys.length;
  const [signers, readonlySigned, readonlyUnsigned] = message.header;
  const find = (pubkey: string) =>
    accounts.findIndex((a) => a.pubkey === pubkey);

  const addWritable: string[] = [];
  const addReadonly: string[] = [];
  const need = (
    pubkey: string,
    writable: boolean,
    signer: boolean,
    program: boolean,
  ) => {
    const at = find(pubkey);
    if (at >= 0) {
      const a = accounts[at];
      if (signer && !a.signer) throw new Error(`${pubkey} would have to sign`);
      if (writable && !a.writable)
        throw new Error(`${pubkey} would have to be writable`);
      if (program && at >= n) {
        throw new Error(`program ${pubkey} is only in a lookup table`);
      }
      return;
    }
    if (signer) throw new Error(`${pubkey} would be a new signer`);
    if (writable) {
      // A key named read-only first and writable later is writable.
      const readonlyAt = addReadonly.indexOf(pubkey);
      if (readonlyAt >= 0) addReadonly.splice(readonlyAt, 1);
      if (!addWritable.includes(pubkey)) addWritable.push(pubkey);
    } else if (!addWritable.includes(pubkey) && !addReadonly.includes(pubkey)) {
      addReadonly.push(pubkey);
    }
  };
  for (const ix of extra) {
    for (const k of ix.keys) need(k.pubkey, k.isWritable, k.isSigner, false);
    need(ix.programId, false, false, true);
  }

  const w = addWritable.length;
  const r = addReadonly.length;
  const writableEnd = n - readonlyUnsigned;
  const remap = (old: number) =>
    old < writableEnd ? old : old < n ? old + w : old + w + r;

  const staticKeys = [
    ...message.staticKeys.slice(0, writableEnd),
    ...addWritable,
    ...message.staticKeys.slice(writableEnd),
    ...addReadonly,
  ];
  const instructions = message.instructions.map((ix) => ({
    programIdIndex: remap(ix.programIdIndex),
    accounts: ix.accounts.map(remap),
    data: ix.data,
  }));
  const next: CompiledMessage = {
    ...message,
    header: [signers, readonlySigned, readonlyUnsigned + r],
    staticKeys,
    instructions,
  };
  const index = (pubkey: string) => {
    const s = staticKeys.indexOf(pubkey);
    if (s >= 0) return s;
    const at = find(pubkey);
    // A lookup-table account: its index moves by every key added before it.
    return at + w + r;
  };
  for (const ix of extra) {
    instructions.push({
      programIdIndex: index(ix.programId),
      accounts: ix.keys.map((k) => index(k.pubkey)),
      data: ix.data,
    });
  }
  return next;
}

/**
 * Raises the transaction's SetComputeUnitLimit by `units` (the instructions
 * added after the aggregator priced its compute), when it has one.
 */
export function raiseComputeUnitLimit(
  message: CompiledMessage,
  units: number,
  computeBudgetProgram: string,
): CompiledMessage {
  const program = message.staticKeys.indexOf(computeBudgetProgram);
  if (program < 0) return message;
  return {
    ...message,
    instructions: message.instructions.map((ix) => {
      if (
        ix.programIdIndex !== program ||
        ix.data[0] !== 2 ||
        ix.data.length !== 5
      ) {
        return ix;
      }
      const data = Uint8Array.from(ix.data);
      const view = new DataView(data.buffer);
      view.setUint32(1, view.getUint32(1, true) + units, true);
      return { ...ix, data };
    }),
  };
}
