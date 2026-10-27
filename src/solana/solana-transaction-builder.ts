import { decodeBase58 } from '@/chains/chain-address';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_MEMO_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
} from '@/solana/solana.constants';

/**
 * Builds the few Solana transactions this service hands a payer, in the legacy
 * wire format, without a Solana SDK (the reading half is `solana-transaction.ts`):
 *
 *   shortvec(n) · n × 64 zero bytes (the signatures the payer adds) · message
 *   message = header(3) · shortvec(keys) · keys · recent blockhash · shortvec(ix) · ix…
 *
 * Accounts are ordered as the runtime requires: writable signers (the fee payer
 * first), read-only signers, writable non-signers, read-only non-signers. Pure;
 * the spec pins the bytes against known instruction layouts.
 */

/** One account an instruction reads or writes. */
export interface SolanaAccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface SolanaInstruction {
  programId: string;
  keys: SolanaAccountMeta[];
  data: Uint8Array;
}

function key(base58: string): Uint8Array {
  const bytes = decodeBase58(base58);
  if (!bytes || bytes.length !== 32) {
    throw new Error(`"${base58}" is not a Solana address`);
  }
  return bytes;
}

/** Solana's compact-u16. */
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

function u64le(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError('amount does not fit a u64');
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/**
 * The unsigned transaction: `feePayer` pays the fee and signs; every other
 * signer an instruction names must sign too. Returns the wire bytes with one
 * zeroed signature slot per signer, as a Solana Pay transaction request answers.
 */
export function buildLegacyTransaction(
  feePayer: string,
  recentBlockhash: string,
  instructions: SolanaInstruction[],
): Uint8Array {
  // Merge every account's flags (a key named twice is signer / writable if
  // any use says so), the fee payer first, then the programs (read-only).
  const metas = new Map<string, { isSigner: boolean; isWritable: boolean }>();
  const add = (pubkey: string, isSigner: boolean, isWritable: boolean) => {
    const seen = metas.get(pubkey);
    metas.set(pubkey, {
      isSigner: (seen?.isSigner ?? false) || isSigner,
      isWritable: (seen?.isWritable ?? false) || isWritable,
    });
  };
  add(feePayer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) add(k.pubkey, k.isSigner, k.isWritable);
  }
  for (const ix of instructions) add(ix.programId, false, false);

  const all = [...metas.entries()];
  const rank = ([pubkey, m]: [
    string,
    { isSigner: boolean; isWritable: boolean },
  ]) =>
    pubkey === feePayer
      ? 0
      : m.isSigner
        ? m.isWritable
          ? 1
          : 2
        : m.isWritable
          ? 3
          : 4;
  // A stable sort keeps first-seen order within a group, as web3.js does.
  const ordered = all
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.i - b.i)
    .map(({ entry }) => entry);
  const keys = ordered.map(([pubkey]) => pubkey);
  const index = new Map(keys.map((k, i) => [k, i]));

  const signers = ordered.filter(([, m]) => m.isSigner);
  const readonlySigned = signers.filter(([, m]) => !m.isWritable).length;
  const readonlyUnsigned = ordered.filter(
    ([, m]) => !m.isSigner && !m.isWritable,
  ).length;

  const message: number[] = [signers.length, readonlySigned, readonlyUnsigned];
  message.push(...shortVec(keys.length));
  for (const k of keys) message.push(...key(k));
  message.push(...key(recentBlockhash));
  message.push(...shortVec(instructions.length));
  for (const ix of instructions) {
    message.push(index.get(ix.programId)!);
    message.push(...shortVec(ix.keys.length));
    for (const k of ix.keys) message.push(index.get(k.pubkey)!);
    message.push(...shortVec(ix.data.length));
    message.push(...ix.data);
  }

  const wire: number[] = [...shortVec(signers.length)];
  for (let i = 0; i < signers.length; i += 1)
    wire.push(...new Array<number>(64).fill(0));
  wire.push(...message);
  return Uint8Array.from(wire);
}

/** System Program `Transfer` (instruction 2): lamports from `from` to `to`. */
export function systemTransfer(
  from: string,
  to: string,
  lamports: bigint,
): SolanaInstruction {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  data.set(u64le(lamports), 4);
  return {
    programId: SYSTEM_PROGRAM_ID,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data,
  };
}

/** SPL Token `TransferChecked` (instruction 12), from the owner's account. */
export function tokenTransferChecked(params: {
  tokenProgram: string;
  source: string;
  mint: string;
  destination: string;
  owner: string;
  amount: bigint;
  decimals: number;
}): SolanaInstruction {
  const data = new Uint8Array(10);
  data[0] = 12;
  data.set(u64le(params.amount), 1);
  data[9] = params.decimals;
  return {
    programId: params.tokenProgram,
    keys: [
      { pubkey: params.source, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.destination, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
    ],
    data,
  };
}

/**
 * Associated Token Account `CreateIdempotent` (instruction 1): the owner's
 * account for `mint`, paid by `payer`, and a no-op when it already exists, so a
 * payment never fails on a receiver that has not held the token yet.
 */
export function createAssociatedTokenAccountIdempotent(params: {
  payer: string;
  account: string;
  owner: string;
  mint: string;
  tokenProgram: string;
}): SolanaInstruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.account, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: params.tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.from([1]),
  };
}

/** SPL Memo: `text` recorded on-chain, with no signer required. */
export function memoInstruction(text: string): SolanaInstruction {
  return {
    programId: SPL_MEMO_PROGRAM_ID,
    keys: [],
    data: new TextEncoder().encode(text),
  };
}

/**
 * Adds `reference` to an instruction as a read-only, non-signing account: how
 * Solana Pay makes a payment findable by `getSignaturesForAddress(reference)`.
 */
export function withReference(
  ix: SolanaInstruction,
  reference: string,
): SolanaInstruction {
  return {
    ...ix,
    keys: [
      ...ix.keys,
      { pubkey: reference, isSigner: false, isWritable: false },
    ],
  };
}
