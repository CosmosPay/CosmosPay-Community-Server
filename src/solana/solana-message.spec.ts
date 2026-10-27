import { encodeBase58 } from '@/chains/chain-address';
import {
  appendInstructions,
  type CompiledMessage,
  decodeTransaction,
  encodeTransaction,
  messageAccounts,
  raiseComputeUnitLimit,
} from '@/solana/solana-message';
import {
  buildLegacyTransaction,
  memoInstruction,
  systemTransfer,
  tokenTransferChecked,
} from '@/solana/solana-transaction-builder';
import { SYSTEM_PROGRAM_ID } from '@/solana/solana.constants';

const k = (n: number) => encodeBase58(new Uint8Array(32).fill(n));
const PAYER = k(1);
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const TABLE = k(50);

/**
 * A v0 swap as an aggregator builds it: the payer, two static writable
 * accounts, a read-only program; a lookup table lending one writable and one
 * read-only account; a compute-limit instruction and a swap instruction.
 */
const v0: CompiledMessage = {
  version: 0,
  header: [1, 0, 2],
  staticKeys: [PAYER, k(2), k(3), COMPUTE_BUDGET, k(40)],
  recentBlockhash: k(9),
  instructions: [
    // SetComputeUnitLimit(200_000)
    {
      programIdIndex: 3,
      accounts: [],
      data: Uint8Array.from([2, 0x40, 0x0d, 0x03, 0]),
    },
    // the swap: static writable, then both table accounts
    {
      programIdIndex: 4,
      accounts: [0, 1, 2, 5, 6],
      data: Uint8Array.from([7, 7]),
    },
  ],
  lookups: [{ account: TABLE, writable: [3], readonly: [0] }],
};
const tables = new Map([[TABLE, [k(60), k(61), k(62), k(63)]]]);

describe('solana message', () => {
  it('reads and writes a legacy transaction byte for byte', () => {
    const bytes = buildLegacyTransaction(PAYER, k(9), [
      memoInstruction('42'),
      systemTransfer(PAYER, k(2), 1000n),
    ]);
    expect(Buffer.from(encodeTransaction(decodeTransaction(bytes)))).toEqual(
      Buffer.from(bytes),
    );
  });

  it('reads and writes a v0 transaction with a lookup table', () => {
    const tx = { signatures: [new Uint8Array(64)], message: v0 };
    const decoded = decodeTransaction(encodeTransaction(tx));
    expect(decoded.message).toEqual(v0);
    expect(messageAccounts(v0, tables).map((a) => a.pubkey)).toEqual([
      PAYER,
      k(2),
      k(3),
      COMPUTE_BUDGET,
      k(40),
      k(63), // table writable
      k(60), // table read-only
    ]);
  });

  it('adds instructions, reusing table accounts and keeping every old one where it was', () => {
    const before = messageAccounts(v0, tables);
    const resolve = (m: CompiledMessage, accounts: number[]) => {
      const all = messageAccounts(m, tables);
      return accounts.map((i) => all[i].pubkey);
    };

    const next = appendInstructions(
      v0,
      [
        systemTransfer(PAYER, k(70), 5n),
        // k(63) is in the table, writable: it must be reused, not added again.
        tokenTransferChecked({
          tokenProgram: k(40),
          source: k(63),
          mint: k(60),
          destination: k(71),
          owner: PAYER,
          amount: 9n,
          decimals: 6,
        }),
      ],
      tables,
    );

    // Two new writable statics (k70, k71) after the old writable ones, one new
    // read-only static (the System Program).
    expect(next.staticKeys).toEqual([
      PAYER,
      k(2),
      k(3),
      k(70),
      k(71),
      COMPUTE_BUDGET,
      k(40),
      SYSTEM_PROGRAM_ID,
    ]);
    expect(next.header).toEqual([1, 0, 3]);
    // The old instructions name the same accounts as before.
    v0.instructions.forEach((ix, i) => {
      expect(resolve(next, next.instructions[i].accounts)).toEqual(
        ix.accounts.map((a) => before[a].pubkey),
      );
      expect(
        messageAccounts(next, tables)[next.instructions[i].programIdIndex]
          .pubkey,
      ).toBe(before[ix.programIdIndex].pubkey);
    });
    // The new ones name theirs, the table's writable account reused.
    expect(resolve(next, next.instructions[2].accounts)).toEqual([
      PAYER,
      k(70),
    ]);
    expect(resolve(next, next.instructions[3].accounts)).toEqual([
      k(63),
      k(60),
      k(71),
      PAYER,
    ]);
    const flags = messageAccounts(next, tables);
    expect(flags.find((a) => a.pubkey === k(70))?.writable).toBe(true);
    expect(flags.find((a) => a.pubkey === SYSTEM_PROGRAM_ID)?.writable).toBe(
      false,
    );
    // And it still writes and reads back.
    expect(
      decodeTransaction(
        encodeTransaction({ signatures: [new Uint8Array(64)], message: next }),
      ).message,
    ).toEqual(next);
  });

  it('refuses what cannot be added safely', () => {
    // A program the message loads from the table (programs must be static).
    expect(() =>
      appendInstructions(
        v0,
        [{ programId: k(60), keys: [], data: new Uint8Array() }],
        new Map([[TABLE, [k(60), k(61), k(62), k(63)]]]),
      ),
    ).toThrow(/lookup table/);
    // A read-only table account that would have to be written.
    expect(() =>
      appendInstructions(v0, [systemTransfer(PAYER, k(60), 1n)], tables),
    ).toThrow(/writable/);
    // A new signer.
    expect(() =>
      appendInstructions(v0, [systemTransfer(k(99), k(70), 1n)], tables),
    ).toThrow(/signer/);
  });

  it('raises the compute unit limit by what was added', () => {
    const next = raiseComputeUnitLimit(v0, 50_000, COMPUTE_BUDGET);
    const data = next.instructions[0].data;
    expect(new DataView(data.buffer).getUint32(1, true)).toBe(250_000);
    // Nothing else moves.
    expect(next.instructions[1]).toEqual(v0.instructions[1]);
  });
});
