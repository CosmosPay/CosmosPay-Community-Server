import {
  FeeBumpTransaction,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

/**
 * The unsigned envelope a stored `xdr` column holds, or `null` when it cannot
 * stand for one: bytes that do not parse, or a fee bump, whose sequence number
 * is the fee account's and says nothing about the inner transaction's.
 *
 * Null never happens for a row this service built, so a caller reading one of
 * its own rows takes null to mean "this row cannot be vouched for" and fails
 * closed.
 */
export function storedEnvelope(
  xdr: string,
  passphrase: string,
): Transaction | null {
  try {
    const tx = TransactionBuilder.fromXDR(xdr, passphrase);
    return tx instanceof FeeBumpTransaction ? null : tx;
  } catch {
    return null;
  }
}

/**
 * Whether a stored in-flight row provably has not reached the chain: the
 * sequence number it holds is still ahead of the account's.
 *
 * A transaction settles only once the account has consumed its sequence number,
 * so a row holding a number the account has not reached cannot be on-chain —
 * and the transaction being built right now takes that same number, so at most
 * one of the two can ever settle.
 *
 * That is what an in-flight guard needs in order to let such a row through.
 * `source` is a public Stellar address and nothing requires the caller to
 * control it, so a row that is merely *built* is otherwise a way to freeze
 * someone else's account for a whole transaction-timeout window — repeatable
 * indefinitely, and worst under the shared public key, where every anonymous
 * wallet is one consumer and consumer scoping buys nothing.
 *
 * False when the envelope cannot be read: nothing about that row is known.
 *
 * `accountSequence` must be read before a `TransactionBuilder` builds from the
 * account — building advances it in place.
 */
export function cannotHaveSettled(
  xdr: string,
  passphrase: string,
  accountSequence: string,
): boolean {
  const envelope = storedEnvelope(xdr, passphrase);
  if (!envelope) return false;
  return BigInt(envelope.sequence) > BigInt(accountSequence);
}
