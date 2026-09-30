/** The SPL Token program — owner of every classic mint and token account. */
export const SPL_TOKEN_PROGRAM_ID =
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Token-2022, the SPL Token extension program. Its mints are accepted too. */
export const SPL_TOKEN_2022_PROGRAM_ID =
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Programs a mint may belong to for an intent to accept it as its asset. */
export const SPL_TOKEN_PROGRAM_IDS: readonly string[] = [
  SPL_TOKEN_PROGRAM_ID,
  SPL_TOKEN_2022_PROGRAM_ID,
];

/**
 * The URI scheme of a Solana Pay transfer request — what a wallet (Phantom,
 * Solflare, Backpack) opens from a link or QR.
 */
export const SOLANA_PAY_SCHEME = 'solana:';

/**
 * Commitment every read asks for. `confirmed` is voted on by a supermajority
 * and in practice never rolled back; `finalized` would add ~13 s to every
 * settlement for a guarantee a merchant does not need to release an order.
 */
export const SOLANA_COMMITMENT = 'confirmed';

/**
 * Signatures read per `getSignaturesForAddress` for an intent's reference key.
 * The key is unique to the intent, so the transactions touching it are the
 * payer's attempts at this one payment — a handful, never a page.
 */
export const SOLANA_REFERENCE_SIGNATURE_LIMIT = 20;

/** The Associated Token Account program: where a wallet holds each token by default. */
export const ASSOCIATED_TOKEN_PROGRAM_ID =
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/**
 * Wrapped SOL. Jupiter swaps native SOL through it (wrapping and unwrapping in
 * the same transaction), so it is the mint a quote names for SOL.
 */
export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
