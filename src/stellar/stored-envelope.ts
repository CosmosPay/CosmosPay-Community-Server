import {
  Asset,
  FeeBumpTransaction,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

/** An issued asset by code and issuer, as a response names it. */
export interface IssuedAsset {
  code: string;
  issuer: string;
}

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

/**
 * The issued asset a stored envelope adds a trustline for on behalf of its own
 * source, or null: the first `changeTrust` the source itself performs (no
 * operation source, or the transaction's) whose line is an asset, not pool
 * shares, and whose limit is not zero (a zero limit removes a trustline).
 *
 * Derived from the envelope rather than stored beside it, so what a response
 * says is always about the bytes the wallet is asked to sign. Null for an
 * envelope that cannot be read.
 */
export function addedTrustline(
  xdr: string,
  passphrase: string,
): IssuedAsset | null {
  const envelope = storedEnvelope(xdr, passphrase);
  if (!envelope) return null;
  for (const op of envelope.operations) {
    if (op.type !== 'changeTrust') continue;
    if (op.source !== undefined && op.source !== envelope.source) continue;
    if (!(op.line instanceof Asset)) continue;
    const issuer = op.line.getIssuer();
    if (op.line.isNative() || !issuer || Number(op.limit) === 0) continue;
    return { code: op.line.getCode(), issuer };
  }
  return null;
}
