import { ed25519 } from '@noble/curves/ed25519.js';
import { decodeBase58, encodeBase58 } from '@/chains/chain-address';
import { associatedTokenAddress } from '@/solana/associated-token-account';
import {
  hasValidSignatures,
  parseSolanaTransaction,
  transactionId,
} from '@/solana/solana-transaction';
import { SPL_TOKEN_PROGRAM_ID } from '@/solana/solana.constants';

/** A minimal v0 message: header, two static keys, a blockhash, no instructions. */
function message(payer: Uint8Array): Uint8Array {
  return Uint8Array.from([
    0x80, // v0
    1,
    0,
    1, // 1 required signature, 0 readonly signed, 1 readonly unsigned
    2, // shortvec: 2 account keys
    ...payer,
    ...new Uint8Array(32).fill(9),
    ...new Uint8Array(32).fill(7), // recent blockhash
    0, // shortvec: no instructions
    0, // shortvec: no address table lookups
  ]);
}

function wire(signature: Uint8Array, msg: Uint8Array): Uint8Array {
  return Uint8Array.from([1, ...signature, ...msg]);
}

describe('parseSolanaTransaction', () => {
  const secret = ed25519.utils.randomSecretKey();
  const payer = ed25519.getPublicKey(secret);
  const msg = message(payer);

  it('reads the signers and the signed bytes, and verifies the signature', () => {
    const tx = parseSolanaTransaction(wire(ed25519.sign(msg, secret), msg));

    expect(tx.numRequiredSignatures).toBe(1);
    expect(tx.signers).toEqual([encodeBase58(payer)]);
    expect(Buffer.from(tx.message).equals(Buffer.from(msg))).toBe(true);
    expect(hasValidSignatures(tx, [payer])).toBe(true);
    expect(transactionId(tx)).toBe(encodeBase58(tx.signatures[0]));
  });

  it('treats an all-zero slot as unsigned — how a built transaction arrives', () => {
    const tx = parseSolanaTransaction(wire(new Uint8Array(64), msg));
    expect(hasValidSignatures(tx, [payer])).toBe(false);
  });

  it('refuses a signature by anyone else, or over other bytes', () => {
    const other = ed25519.utils.randomSecretKey();
    const forged = parseSolanaTransaction(wire(ed25519.sign(msg, other), msg));
    expect(hasValidSignatures(forged, [payer])).toBe(false);

    const tampered = Uint8Array.from(msg);
    tampered[tampered.length - 3] ^= 1;
    const moved = parseSolanaTransaction(
      wire(ed25519.sign(msg, secret), tampered),
    );
    expect(hasValidSignatures(moved, [payer])).toBe(false);
  });

  it('refuses malformed wire bytes', () => {
    expect(() => parseSolanaTransaction(Uint8Array.from([0]))).toThrow();
    expect(() => parseSolanaTransaction(Uint8Array.from([2, 1, 2]))).toThrow();
    // Two signatures for a message that asks for one.
    const two = Uint8Array.from([2, ...new Uint8Array(128), ...msg]);
    expect(() => parseSolanaTransaction(two)).toThrow('signature count');
  });
});

describe('associatedTokenAddress', () => {
  it('matches the account Jupiter creates for a wallet’s USDC (mainnet)', () => {
    // Read from Jupiter's swap-instructions for this wallet, 2026-09-30.
    expect(
      associatedTokenAddress(
        '13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        SPL_TOKEN_PROGRAM_ID,
      ),
    ).toBe('6Ta6QEER1jvgZ2yYx5iJwXxtzYqMr6xv7gvxW5ZPX1iW');
  });

  it('is off the curve — an address no key can sign for', () => {
    const ata = associatedTokenAddress(
      '13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      SPL_TOKEN_PROGRAM_ID,
    );
    expect(() => ed25519.Point.fromBytes(decodeBase58(ata)!)).toThrow();
  });
});
