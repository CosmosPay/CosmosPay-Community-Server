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
 * The rules every Soroban envelope a provider builds for this service is held
 * to before it is recorded for a submit (DeFindex, Trustless Work), and the
 * rules a signed copy is held to on its way back. Pure: the tables, the
 * provider calls and what each call's arguments must be are the plugins'.
 *
 * Extracted from the DeFindex plugin when Trustless Work needed the same
 * checks: two private copies of "one invokeContract, no memo, bounded fee and
 * time" is exactly how such rules drift apart.
 */

/** What a built envelope may cost and how long it may stay valid. */
export interface BuiltEnvelopeLimits {
  /** Inclusion fee and Soroban resource fee together, in stroops. */
  maxFeeStroops: bigint;
  /** The furthest from `now` the envelope's `maxTime` may be. */
  maxValidityMs: number;
  /** Clock difference tolerated on both time bounds. */
  clockSkewMs: number;
  now: Date;
}

/** One contract call: where, what, and its arguments as XDR. */
export interface ContractCall {
  contract: string;
  function: string;
  args: xdr.ScVal[];
}

/** An authorized invocation, as stellar-sdk 17 exposes one (fields are properties). */
export interface AuthorizedInvocation {
  function?: { type?: string; contractFn?: unknown };
  subInvocations?: AuthorizedInvocation[];
}

/** One authorization entry of the operation, read as plain data. */
export interface AuthorizationEntry {
  credentials?: { type?: string; address?: { address?: xdr.ScAddress } };
  rootInvocation?: AuthorizedInvocation;
}

/** An envelope that passed {@link checkSingleContractCall}, taken apart. */
export interface SingleContractCall {
  tx: Transaction;
  call: ContractCall;
  auth: AuthorizationEntry[];
}

export type SingleContractCallCheck =
  ({ ok: true } & SingleContractCall) | { ok: false; reason: string };

/** The parts of a v1 envelope's transaction the checks read. */
interface EnvelopeBody {
  cond: { type: string };
  ext: { sorobanData?: { resourceFee: bigint | number | string } };
}

/**
 * Whether `envelope` is one plain call a provider built for `source`, and
 * nothing else, in this order:
 *
 *  - a plain v1 transaction (no fee bump) whose source is `source`, with no
 *    memo and no precondition but time bounds;
 *  - time bounds set, already open, closing in the future no later than
 *    `maxValidityMs` from now;
 *  - Soroban resources, and a fee (the resource fee included) within
 *    `maxFeeStroops`;
 *  - ONE operation, sourced by `source` or by nobody, invoking a contract.
 *
 * What the call is (contract, function, arguments, authorization) is the
 * caller's to check on the parts this returns.
 */
export function checkSingleContractCall(
  envelope: string,
  passphrase: string,
  source: string,
  limits: BuiltEnvelopeLimits,
): SingleContractCallCheck {
  const refuse = (reason: string): SingleContractCallCheck => ({
    ok: false,
    reason,
  });

  let parsed: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    parsed = TransactionBuilder.fromXDR(envelope, passphrase);
  } catch {
    return refuse('it is not a transaction envelope');
  }
  if (parsed instanceof FeeBumpTransaction) return refuse('it is a fee bump');
  const body = envelopeBody(parsed);
  if (!body) return refuse('it is not a v1 transaction envelope');
  if (parsed.source !== source) {
    return refuse('its source is not the caller');
  }
  if (parsed.memo.type !== 'none') return refuse('it carries a memo');
  if (body.cond.type !== 'precondTime') {
    return refuse('it carries preconditions beyond time bounds');
  }

  const time = timeBoundsRefusal(parsed, limits);
  if (time) return refuse(time);

  const sorobanData = body.ext.sorobanData;
  if (!sorobanData) return refuse('it carries no Soroban resources');
  const fee = BigInt(parsed.fee);
  if (fee > limits.maxFeeStroops) {
    return refuse(`its fee ${fee} exceeds ${limits.maxFeeStroops} stroops`);
  }
  const resourceFee = BigInt(sorobanData.resourceFee);
  if (resourceFee < 0n || resourceFee > fee) {
    return refuse(`its resource fee ${resourceFee} is not within its fee`);
  }

  if (parsed.operations.length !== 1) {
    return refuse('it does not make exactly one operation');
  }
  const [op] = parsed.operations;
  if (op.source !== undefined && op.source !== source) {
    return refuse('its operation has another source');
  }
  if (op.type !== 'invokeHostFunction') {
    return refuse('its operation is not a contract call');
  }
  const call = contractCallOf(
    (op.func as unknown as { invokeContract?: unknown }).invokeContract,
  );
  if (!call) return refuse('its operation is not a contract call');

  return {
    ok: true,
    tx: parsed,
    call,
    auth: (op as unknown as { auth?: AuthorizationEntry[] }).auth ?? [],
  };
}

/**
 * Why the operation's authorization entries are not exactly ONE entry of
 * `signer` (source-account credentials, or address credentials of `signer`)
 * rooted at `call`, or null when they are. What may sit under the root is the
 * caller's to check: {@link rootSubInvocations} reads it.
 */
export function rootAuthorizationRefusal(
  entries: AuthorizationEntry[],
  signer: string,
  call: ContractCall,
): string | null {
  if (entries.length !== 1) {
    return `it carries ${entries.length} authorization entries, not one`;
  }
  const [entry] = entries;
  const credentials = entry.credentials;
  if (credentials?.type === 'sorobanCredentialsAddress') {
    const address = credentials.address?.address;
    if (!address || scAddressText(address) !== signer) {
      return 'its authorization is for another address';
    }
  } else if (credentials?.type !== 'sorobanCredentialsSourceAccount') {
    return 'its authorization has unknown credentials';
  }

  const root = entry.rootInvocation;
  const rootCall = contractCallOf(root?.function?.contractFn);
  if (
    root?.function?.type !== 'sorobanAuthorizedFunctionTypeContractFn' ||
    !rootCall ||
    rootCall.contract !== call.contract ||
    rootCall.function !== call.function ||
    !sameXdr(rootCall.args, call.args)
  ) {
    return 'its authorization is not for the requested call';
  }
  return null;
}

/** The invocations authorized under the one entry's root (none when absent). */
export function rootSubInvocations(
  entries: AuthorizationEntry[],
): AuthorizedInvocation[] {
  return entries[0]?.rootInvocation?.subInvocations ?? [];
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

/** An `InvokeContractArgs` read as plain data, or null when it is not one. */
export function contractCallOf(value: unknown): ContractCall | null {
  const call = value as
    | {
        contractAddress?: xdr.ScAddress;
        functionName?: unknown;
        args?: xdr.ScVal[];
      }
    | undefined;
  if (!call?.contractAddress || !Array.isArray(call.args)) return null;
  const contract = scAddressText(call.contractAddress);
  if (!contract) return null;
  // An `XdrString` in stellar-sdk 17: `String` reads its text.
  return { contract, function: String(call.functionName), args: call.args };
}

export function scAddressText(address: xdr.ScAddress): string | null {
  try {
    return Address.fromScAddress(address).toString();
  } catch {
    return null;
  }
}

/** The address an argument names, or null when it is not an address. */
export function addressOf(value: xdr.ScVal): string | null {
  if (value.type !== 'scvAddress') return null;
  const decoded = scNative(value);
  return typeof decoded === 'string' ? decoded : null;
}

/** `scValToNative`, or undefined for a value it cannot decode. */
export function scNative(value: xdr.ScVal): unknown {
  try {
    return scValToNative(value) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether two argument lists serialize to the same bytes. */
export function sameXdr(a: xdr.ScVal[], b: xdr.ScVal[]): boolean {
  return (
    a.length === b.length &&
    a.every((value, i) => value.toXDR('base64') === b[i].toXDR('base64'))
  );
}

/** The transaction of a v1 envelope, or null for any other kind. */
function envelopeBody(tx: Transaction): EnvelopeBody | null {
  const envelope = tx.toEnvelope() as unknown as {
    type?: string;
    v1?: { tx?: EnvelopeBody };
  };
  return envelope.type === 'envelopeTypeTx' && envelope.v1?.tx
    ? envelope.v1.tx
    : null;
}

/** Why the time bounds are not acceptable, or null when they are. */
function timeBoundsRefusal(
  tx: Transaction,
  limits: BuiltEnvelopeLimits,
): string | null {
  const now = limits.now.getTime();
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0) * 1000;
  const minTime = Number(tx.timeBounds?.minTime ?? 0) * 1000;
  if (!Number.isFinite(maxTime) || maxTime <= 0) {
    return 'it has no upper time bound';
  }
  if (maxTime <= now) return 'its time bounds already closed';
  if (maxTime > now + limits.maxValidityMs + limits.clockSkewMs) {
    return 'its time bounds stay open too long';
  }
  if (!Number.isFinite(minTime) || minTime > now + limits.clockSkewMs) {
    return 'it is not valid yet';
  }
  return null;
}
