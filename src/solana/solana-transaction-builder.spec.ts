import { decodeBase58, encodeBase58 } from '@/chains/chain-address';
import { parseSolanaTransaction } from '@/solana/solana-transaction';
import {
  buildLegacyTransaction,
  createAssociatedTokenAccountIdempotent,
  memoInstruction,
  systemTransfer,
  tokenTransferChecked,
  withReference,
} from '@/solana/solana-transaction-builder';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_MEMO_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
} from '@/solana/solana.constants';

/** Deterministic 32-byte keys, base58 (not real accounts). */
const k = (n: number) => encodeBase58(new Uint8Array(32).fill(n));
const PAYER = k(1);
const MERCHANT = k(2);
const FEE = k(3);
const REFERENCE = k(4);
const BLOCKHASH = k(9);

/** Reads the message the builder wrote: keys, blockhash and instructions. */
function decode(bytes: Uint8Array) {
  const parsed = parseSolanaTransaction(bytes);
  const m = parsed.message;
  const header = [m[0], m[1], m[2]];
  let at = 3;
  const keyCount = m[at++];
  const keys: string[] = [];
  for (let i = 0; i < keyCount; i += 1) {
    keys.push(encodeBase58(m.subarray(at, at + 32)));
    at += 32;
  }
  const blockhash = encodeBase58(m.subarray(at, at + 32));
  at += 32;
  const ixCount = m[at++];
  const ixs: { program: string; accounts: string[]; data: number[] }[] = [];
  for (let i = 0; i < ixCount; i += 1) {
    const program = keys[m[at++]];
    const n = m[at++];
    const accounts = [...m.subarray(at, at + n)].map((x) => keys[x]);
    at += n;
    const len = m[at++];
    const data = [...m.subarray(at, at + len)];
    at += len;
    ixs.push({ program, accounts, data });
  }
  return { parsed, header, keys, blockhash, ixs, rest: m.length - at };
}

describe('buildLegacyTransaction', () => {
  it('writes a SOL payment with its memo, a reference and a second transfer', () => {
    const bytes = buildLegacyTransaction(PAYER, BLOCKHASH, [
      memoInstruction('42'),
      withReference(systemTransfer(PAYER, MERCHANT, 1_500_000_000n), REFERENCE),
      systemTransfer(PAYER, FEE, 25_000_000n),
    ]);
    const tx = decode(bytes);

    // One signer (the payer, writable), no read-only signer, and the
    // read-only non-signers: the reference and the two programs.
    expect(tx.parsed.signers).toEqual([PAYER]);
    expect(tx.parsed.signatures[0].every((b) => b === 0)).toBe(true);
    expect(tx.header).toEqual([1, 0, 3]);
    expect(tx.keys).toEqual([
      PAYER,
      MERCHANT,
      FEE,
      REFERENCE,
      SPL_MEMO_PROGRAM_ID,
      SYSTEM_PROGRAM_ID,
    ]);
    expect(tx.blockhash).toBe(BLOCKHASH);
    expect(tx.rest).toBe(0);

    expect(tx.ixs[0]).toEqual({
      program: SPL_MEMO_PROGRAM_ID,
      accounts: [],
      data: [...new TextEncoder().encode('42')],
    });
    // System Transfer: u32 2, then u64 lamports, little-endian.
    expect(tx.ixs[1].program).toBe(SYSTEM_PROGRAM_ID);
    expect(tx.ixs[1].accounts).toEqual([PAYER, MERCHANT, REFERENCE]);
    expect(tx.ixs[1].data).toEqual([
      2, 0, 0, 0, 0x00, 0x2f, 0x68, 0x59, 0, 0, 0, 0,
    ]);
    expect(tx.ixs[2].accounts).toEqual([PAYER, FEE]);
  });

  it('writes a token payment: idempotent account creation, then TransferChecked', () => {
    const MINT = k(5);
    const SOURCE = k(6);
    const DEST_ATA = k(7);
    const bytes = buildLegacyTransaction(PAYER, BLOCKHASH, [
      createAssociatedTokenAccountIdempotent({
        payer: PAYER,
        account: DEST_ATA,
        owner: MERCHANT,
        mint: MINT,
        tokenProgram: SPL_TOKEN_PROGRAM_ID,
      }),
      tokenTransferChecked({
        tokenProgram: SPL_TOKEN_PROGRAM_ID,
        source: SOURCE,
        mint: MINT,
        destination: DEST_ATA,
        owner: PAYER,
        amount: 2_500_000n,
        decimals: 6,
      }),
    ]);
    const tx = decode(bytes);

    expect(tx.ixs[0].program).toBe(ASSOCIATED_TOKEN_PROGRAM_ID);
    expect(tx.ixs[0].data).toEqual([1]);
    expect(tx.ixs[0].accounts).toEqual([
      PAYER,
      DEST_ATA,
      MERCHANT,
      MINT,
      SYSTEM_PROGRAM_ID,
      SPL_TOKEN_PROGRAM_ID,
    ]);
    // TransferChecked: 12, u64 amount, u8 decimals.
    expect(tx.ixs[1].data).toEqual([12, 0xa0, 0x25, 0x26, 0, 0, 0, 0, 0, 6]);
    expect(tx.ixs[1].accounts).toEqual([SOURCE, MINT, DEST_ATA, PAYER]);
    // Writable before read-only among non-signers.
    const writable = tx.keys.slice(1, 1 + (tx.keys.length - 1 - tx.header[2]));
    expect(writable).toEqual(expect.arrayContaining([DEST_ATA, SOURCE]));
    expect(decodeBase58(tx.keys[0])).toEqual(new Uint8Array(32).fill(1));
  });

  it('refuses an amount past a u64 and a key that is not one', () => {
    expect(() => systemTransfer(PAYER, MERCHANT, 2n ** 64n)).toThrow(
      RangeError,
    );
    expect(() =>
      buildLegacyTransaction(PAYER, BLOCKHASH, [
        systemTransfer(PAYER, '0xnot-a-key', 1n),
      ]),
    ).toThrow();
  });
});
