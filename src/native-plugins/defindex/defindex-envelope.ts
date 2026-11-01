import {
  Address,
  FeeBumpTransaction,
  scValToNative,
  type Transaction,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';

/**
 * The rules a DeFindex transaction is held to, on its way out (the envelope
 * DeFindex built) and on its way back (the copy the caller signed). Pure: the
 * table and the provider calls are the services'.
 */

/** What the caller asked DeFindex to build: the one call its envelope must make. */
export type ExpectedDefindexCall =
  | {
      kind: 'deposit';
      vault: string;
      caller: string;
      amounts: readonly bigint[];
      invest: boolean;
    }
  | { kind: 'withdraw'; vault: string; caller: string; shares: bigint };

/** One contract invocation, its arguments decoded to native values. */
interface Invocation {
  contract: string;
  function: string;
  args: unknown[];
}

/**
 * The unsigned envelope DeFindex built, once it is shown to be exactly the call
 * that was asked for: a plain transaction (no fee bump) whose source is the
 * caller, with ONE operation, which invokes `deposit` or `withdraw` on the
 * vault with the caller's amounts (or shares) and the caller as `from`.
 *
 * The same shape the wallet checks before it signs (`assertSafeDefindexTransaction`).
 * Checked here too because the row this envelope becomes is what
 * `POST /v1/defindex/submit` will relay: nothing DeFindex returns gets that
 * standing unless it is the transaction this service was asked to build.
 * Anything else is DeFindex misbehaving, a `502 provider_error`.
 */
export function verifyBuiltEnvelope(
  envelope: string,
  passphrase: string,
  expected: ExpectedDefindexCall,
): Transaction {
  const refuse = (reason: string): never => {
    throw ApiError.badGateway(
      ApiErrorCode.ProviderError,
      `DeFindex built a transaction that is not the requested ${expected.kind}: ${reason}`,
    );
  };

  let parsed: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    parsed = TransactionBuilder.fromXDR(envelope, passphrase);
  } catch {
    return refuse('it is not a transaction envelope');
  }
  if (parsed instanceof FeeBumpTransaction) return refuse('it is a fee bump');
  if (parsed.source !== expected.caller) {
    return refuse('its source is not the caller');
  }
  if (parsed.operations.length !== 1) {
    return refuse('it does not make exactly one operation');
  }
  const [op] = parsed.operations;
  if (op.source !== undefined && op.source !== expected.caller) {
    return refuse('its operation has another source');
  }
  const call = invocationOf(op);
  if (!call) return refuse('its operation is not a contract call');
  if (call.contract !== expected.vault) {
    return refuse('it calls another contract');
  }
  if (call.function !== expected.kind) {
    return refuse(`it calls ${call.function}`);
  }

  if (expected.kind === 'deposit') {
    const [desired, minimum, from, invest] = call.args;
    if (
      call.args.length !== 4 ||
      !sameAmounts(desired, expected.amounts) ||
      !minimaWithin(minimum, expected.amounts) ||
      from !== expected.caller ||
      invest !== expected.invest
    ) {
      return refuse('its arguments differ from the request');
    }
  } else {
    const [shares, minimum, from] = call.args;
    if (
      call.args.length !== 3 ||
      shares !== expected.shares ||
      !Array.isArray(minimum) ||
      from !== expected.caller
    ) {
      return refuse('its arguments differ from the request');
    }
  }
  return parsed;
}

/**
 * The caller's signed envelope, parsed under the network of the API key that
 * submits it, and refused (`400 validation_failed`) when it cannot be one this
 * service built: not an envelope, a fee bump (it hashes as the fee bump, never
 * as the transaction that was built), or no signature at all (the unsigned
 * envelope the build handed out hashes the same as a signed one, and relaying
 * it can only be rejected). Whether a signature is VALID is the network's call.
 */
export function signedEnvelope(
  envelope: string,
  passphrase: string,
): Transaction {
  let parsed: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    parsed = TransactionBuilder.fromXDR(envelope, passphrase);
  } catch {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'xdr is not a valid transaction envelope',
    );
  }
  if (parsed instanceof FeeBumpTransaction) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'xdr is a fee bump; submit the transaction the build returned, signed',
    );
  }
  if (parsed.signatures.length === 0) {
    throw ApiError.badRequest(
      ApiErrorCode.ValidationFailed,
      'xdr carries no signatures; sign the transaction before submitting it',
    );
  }
  return parsed;
}

/**
 * The transaction's hash, lowercase hex. It covers the network passphrase and
 * the whole transaction body, never the signatures: a signed copy of a built
 * transaction hashes the same, and any other change does not.
 */
export function transactionHash(tx: Transaction): string {
  return Buffer.from(tx.hash()).toString('hex');
}

/**
 * When a transaction built at `builtAt` stops being submittable: its own
 * `maxTime` (the bound the network enforces), or `ttlMs` after the build when
 * that comes first or the envelope has no upper bound.
 */
export function submittableUntil(
  tx: Transaction,
  builtAt: Date,
  ttlMs: number,
): Date {
  const cap = builtAt.getTime() + ttlMs;
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0) * 1000;
  return new Date(maxTime > 0 ? Math.min(maxTime, cap) : cap);
}

/** What a single operation invokes, or null when it is not a direct contract call. */
function invocationOf(
  op: Transaction['operations'][number],
): Invocation | null {
  if (op.type !== 'invokeHostFunction') return null;
  const call = (
    op.func as unknown as {
      invokeContract?: {
        contractAddress: xdr.ScAddress;
        functionName: unknown;
        args: xdr.ScVal[];
      };
    }
  ).invokeContract;
  if (!call) return null;
  try {
    return {
      contract: Address.fromScAddress(call.contractAddress).toString(),
      // An `XdrString` in stellar-sdk 17: `String` reads its text.
      function: String(call.functionName),
      args: call.args.map((arg) => scValToNative(arg) as unknown),
    };
  } catch {
    return null;
  }
}

/** Whether `value` is a list of exactly these amounts, in order. */
function sameAmounts(value: unknown, amounts: readonly bigint[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === amounts.length &&
    value.every((amount, i) => amount === amounts[i])
  );
}

/** Whether `value` is one minimum per amount, each between zero and its amount. */
function minimaWithin(value: unknown, amounts: readonly bigint[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === amounts.length &&
    value.every(
      (min, i) => typeof min === 'bigint' && min >= 0n && min <= amounts[i],
    )
  );
}
