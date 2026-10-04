import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeBase58, encodeBase58 } from '@/chains/chain-address';
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '@/solana/solana.constants';

/** Whether 32 bytes are a point on ed25519 — a key someone could hold. */
function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

function key(base58: string): Uint8Array {
  const bytes = decodeBase58(base58);
  if (!bytes || bytes.length !== 32) {
    throw new Error(`"${base58}" is not a Solana address`);
  }
  return bytes;
}

/**
 * `PublicKey.findProgramAddressSync`: the first bump, counting down from 255,
 * whose `sha256(seeds ‖ bump ‖ program ‖ "ProgramDerivedAddress")` is off the
 * curve — an address only the program can sign for.
 */
export function findProgramAddress(
  seeds: Uint8Array[],
  programId: string,
): string {
  const program = key(programId);
  const marker = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = sha256(
      Uint8Array.from(
        Buffer.concat([
          ...seeds.map((s) => Buffer.from(s)),
          Buffer.from([bump]),
          Buffer.from(program),
          Buffer.from(marker),
        ]),
      ),
    );
    if (!isOnCurve(hash)) return encodeBase58(hash);
  }
  throw new Error('no viable bump for these seeds');
}

/**
 * The associated token account of `owner` for `mint` under `tokenProgram`
 * (the SPL Token or Token-2022 program that owns the mint) — the account a
 * wallet holds that token in by default.
 */
export function associatedTokenAddress(
  owner: string,
  mint: string,
  tokenProgram: string,
): string {
  return findProgramAddress(
    [key(owner), key(tokenProgram), key(mint)],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}
