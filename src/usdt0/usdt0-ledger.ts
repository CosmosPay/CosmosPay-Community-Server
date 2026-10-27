import {
  FeeBumpTransaction,
  rpc,
  type Transaction,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { parseSendReceipt, type SendReceipt } from '@/usdt0/usdt0-oft';

/**
 * What the Stellar ledger says about a USDT0 transfer's transaction, as plain
 * data. Pure: the RPC calls are the tracker's and the service's.
 */

/**
 * The caller's signed envelope, once it is shown to be the one built for this
 * transfer and to carry a signature. Checked before anything about the
 * transfer is answered, as `SignedTransactionRelay` does for swaps: under the
 * shared public key every anonymous caller is one consumer, so the id alone
 * must not be enough to learn a transfer's state or to make this service
 * broadcast.
 *
 * Signing does not change a transaction's hash, so the hash under mainnet's
 * passphrase must be the one stored. A fee bump hashes differently and is
 * refused with it. Whether the signature is VALID is the network's call; an
 * envelope with none is the unsigned one the create response handed out.
 */
export function verifySignedEnvelope(
  signedXdr: string,
  expected: { txHash: string; passphrase: string },
): Transaction {
  let parsed: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    parsed = TransactionBuilder.fromXDR(signedXdr, expected.passphrase);
  } catch {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'signedXdr is not a valid transaction envelope',
    );
  }
  if (
    parsed instanceof FeeBumpTransaction ||
    Buffer.from(parsed.hash()).toString('hex') !== expected.txHash
  ) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'The signed transaction does not match this transfer',
    );
  }
  if (parsed.signatures.length === 0) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'signedXdr carries no signatures; sign the transaction before submitting it',
    );
  }
  return parsed;
}

/** Whether the network can no longer accept the envelope: its time bounds have closed. */
export function hasLapsed(
  tx: Transaction,
  expiresAt: Date,
  now = Date.now(),
): boolean {
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (maxTime > 0 && now > maxTime * 1000) return true;
  return now > expiresAt.getTime();
}

/**
 * A transaction result as Horizon spells its codes: the transaction's
 * (`tx_failed`, `tx_bad_auth`, ...) and, when it failed applying, each
 * operation's (`invoke_host_function_trapped`, ...). Empty when there is no
 * result to read.
 */
export function resultCodes(
  result: xdr.TransactionResult | undefined,
): string[] {
  const outcome = (result as { result?: unknown } | undefined)?.result as
    { type?: unknown; results?: unknown } | undefined;
  if (!outcome || typeof outcome.type !== 'string') return [];
  const codes = [snakeCase(outcome.type)];
  if (Array.isArray(outcome.results)) {
    for (const op of outcome.results as { type?: unknown; tr?: unknown }[]) {
      const code = operationCode(op);
      if (code) codes.push(code);
    }
  }
  return codes;
}

/** What the ledger says about the transaction, by its `getTransaction`. */
export type LedgerOutcome =
  /** Applied. `receipt` is null only when its return value could not be read. */
  | { kind: 'succeeded'; receipt: SendReceipt | null }
  /** Applied and failed: the fee was charged, nothing was sent. */
  | { kind: 'failed'; codes: string[] }
  /** Not on the ledger (yet, or ever). */
  | { kind: 'absent' };

export function ledgerOutcome(
  response: rpc.Api.GetTransactionResponse,
): LedgerOutcome {
  switch (response.status) {
    case rpc.Api.GetTransactionStatus.SUCCESS:
      return { kind: 'succeeded', receipt: readReceipt(response.returnValue) };
    case rpc.Api.GetTransactionStatus.FAILED:
      return { kind: 'failed', codes: resultCodes(response.resultXdr) };
    default:
      return { kind: 'absent' };
  }
}

/** `send`'s receipt, or null when there is no return value or it cannot be read. */
function readReceipt(retval: xdr.ScVal | undefined): SendReceipt | null {
  if (!retval) return null;
  try {
    return parseSendReceipt(retval);
  } catch {
    return null;
  }
}

/** One operation's code: the inner result when it ran, else the outer one. */
function operationCode(op: { type?: unknown; tr?: unknown }): string | null {
  if (typeof op?.type !== 'string') return null;
  const tr = op.tr as Record<string, unknown> | undefined;
  if (op.type === 'opInner' && tr && typeof tr.type === 'string') {
    const inner = tr[`${tr.type}Result`] as { type?: unknown } | undefined;
    if (typeof inner?.type === 'string') return snakeCase(inner.type);
    return snakeCase(tr.type);
  }
  return snakeCase(op.type);
}

/** `txBadAuth` → `tx_bad_auth`, the spelling Horizon and wallets show. */
function snakeCase(code: string): string {
  return code.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
