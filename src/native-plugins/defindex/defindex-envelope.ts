import {
  Address,
  FeeBumpTransaction,
  scValToNative,
  type Transaction,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { DEFINDEX_MAX_VAULT_ASSETS } from '@/native-plugins/defindex/defindex.constants';

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
      slippageBps: number;
    }
  | {
      kind: 'withdraw';
      vault: string;
      caller: string;
      shares: bigint;
      slippageBps: number;
    };

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

export type BuiltEnvelopeCheck =
  { ok: true; tx: Transaction } | { ok: false; reason: string };

/** One contract call: where, what, and its arguments as XDR. */
interface ContractCall {
  contract: string;
  function: string;
  args: xdr.ScVal[];
}

/** An authorized invocation, as stellar-sdk 17 exposes one (fields are properties). */
interface AuthorizedInvocation {
  function?: { type?: string; contractFn?: unknown };
  subInvocations?: AuthorizedInvocation[];
}

/** One authorization entry of the operation, read as plain data. */
interface AuthorizationEntry {
  credentials?: { type?: string; address?: { address?: xdr.ScAddress } };
  rootInvocation?: AuthorizedInvocation;
}

/** The parts of a v1 envelope's transaction the checks read. */
interface EnvelopeBody {
  cond: { type: string };
  ext: { sorobanData?: { resourceFee: bigint | number | string } };
}

/** Basis points in a whole: 10000 is 100% slippage. */
const BPS = 10_000n;

/**
 * Whether the unsigned envelope DeFindex built is exactly the call that was
 * asked for, and nothing a compromised or buggy DeFindex could slip into it.
 * The row this envelope becomes is what `POST /v1/defindex/submit` will relay,
 * so it gets that standing only when, in this order:
 *
 *  - it is a plain v1 transaction (no fee bump) whose source is `caller`, with
 *    no memo and no precondition but time bounds;
 *  - its time bounds are set, already open, and close in the future no later
 *    than `maxValidityMs` from now;
 *  - it carries Soroban resources, and its fee (the resource fee included) is
 *    within `maxFeeStroops`;
 *  - it makes ONE operation, sourced by the caller, invoking `deposit` or
 *    `withdraw` on the vault with the caller's amounts (or shares) and `from`,
 *    and minimums the requested `slippageBps` allows (a deposit's are checked
 *    against its amounts; a withdrawal's outputs depend on the vault's state,
 *    so only their shape is);
 *  - its ONE authorization entry is the caller's (source-account credentials,
 *    or address credentials of `caller`), rooted at exactly that call, and
 *    authorizes nothing else: for a deposit only the vault pulling at most the
 *    requested amounts from the caller (`transfer(caller, vault, x)`, one per
 *    asset token), for a withdrawal nothing at all. A mainnet simulation of
 *    real DeFindex vaults (2026-11-01) recorded exactly that.
 *
 * A refusal names its reason; the caller logs it and answers
 * `502 provider_error` ({@link builtEnvelopeRefused}).
 */
export function checkBuiltEnvelope(
  envelope: string,
  passphrase: string,
  expected: ExpectedDefindexCall,
  limits: BuiltEnvelopeLimits,
): BuiltEnvelopeCheck {
  const refuse = (reason: string): BuiltEnvelopeCheck => ({
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
  if (parsed.source !== expected.caller) {
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
  if (op.source !== undefined && op.source !== expected.caller) {
    return refuse('its operation has another source');
  }
  if (op.type !== 'invokeHostFunction') {
    return refuse('its operation is not a contract call');
  }
  const call = contractCallOf(
    (op.func as unknown as { invokeContract?: unknown }).invokeContract,
  );
  if (!call) return refuse('its operation is not a contract call');
  if (call.contract !== expected.vault) {
    return refuse('it calls another contract');
  }
  if (call.function !== expected.kind) {
    return refuse(`it calls ${call.function}`);
  }
  const args =
    expected.kind === 'deposit'
      ? depositArgsRefusal(call.args, expected)
      : withdrawArgsRefusal(call.args, expected);
  if (args) return refuse(args);

  const auth = authRefusal(
    (op as unknown as { auth?: AuthorizationEntry[] }).auth ?? [],
    call,
    expected,
  );
  if (auth) return refuse(auth);

  return { ok: true, tx: parsed };
}

/** The `502 provider_error` a refused build answers. */
export function builtEnvelopeRefused(
  kind: ExpectedDefindexCall['kind'],
  reason: string,
): ApiError {
  return ApiError.badGateway(
    ApiErrorCode.ProviderError,
    `DeFindex built a transaction that is not the requested ${kind}: ${reason}`,
  );
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

/** `deposit(amounts_desired, amounts_min, from, invest)`, as requested. */
function depositArgsRefusal(
  args: xdr.ScVal[],
  expected: Extract<ExpectedDefindexCall, { kind: 'deposit' }>,
): string | null {
  if (args.length !== 4) return 'its deposit does not take four arguments';
  const [desiredArg, minimumArg, fromArg, investArg] = args;
  const desired = i128List(desiredArg);
  if (!desired || !sameList(desired, expected.amounts)) {
    return 'its deposit amounts differ from the request';
  }
  const minimum = i128List(minimumArg);
  if (!minimum || minimum.length !== expected.amounts.length) {
    return 'its minimum amounts are not one per amount';
  }
  for (const [i, min] of minimum.entries()) {
    const amount = expected.amounts[i];
    if (min < slippageFloor(amount, expected.slippageBps) || min > amount) {
      return `its minimum amount ${i + 1} is not what slippageBps ${expected.slippageBps} allows`;
    }
  }
  if (addressOf(fromArg) !== expected.caller) {
    return 'its deposit is not from the caller';
  }
  if (investArg.type !== 'scvBool' || native(investArg) !== expected.invest) {
    return 'its invest flag differs from the request';
  }
  return null;
}

/** `withdraw(withdraw_shares, min_amounts_out, from)`, as requested. */
function withdrawArgsRefusal(
  args: xdr.ScVal[],
  expected: Extract<ExpectedDefindexCall, { kind: 'withdraw' }>,
): string | null {
  if (args.length !== 3) return 'its withdrawal does not take three arguments';
  const [sharesArg, minimumArg, fromArg] = args;
  if (sharesArg.type !== 'scvI128' || native(sharesArg) !== expected.shares) {
    return 'its share count differs from the request';
  }
  // What a withdrawal pays out depends on the vault's state when it lands, so
  // the level of each minimum cannot be checked against slippageBps from the
  // envelope; the vault enforces them on-chain. Their shape can be.
  const minimum = i128List(minimumArg);
  if (
    !minimum ||
    minimum.length < 1 ||
    minimum.length > DEFINDEX_MAX_VAULT_ASSETS ||
    minimum.some((min) => min < 0n)
  ) {
    return 'its minimum outputs are not one non-negative amount per vault asset';
  }
  if (addressOf(fromArg) !== expected.caller) {
    return 'its withdrawal is not from the caller';
  }
  return null;
}

/**
 * Why the operation's authorization entries are not exactly the caller's
 * authorization of `call`, or null when they are.
 */
function authRefusal(
  entries: AuthorizationEntry[],
  call: ContractCall,
  expected: ExpectedDefindexCall,
): string | null {
  if (entries.length !== 1) {
    return `it carries ${entries.length} authorization entries, not one`;
  }
  const [entry] = entries;
  const credentials = entry.credentials;
  if (credentials?.type === 'sorobanCredentialsAddress') {
    const signer = credentials.address?.address;
    if (!signer || scAddressText(signer) !== expected.caller) {
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

  const subs = root.subInvocations ?? [];
  if (expected.kind === 'withdraw') {
    return subs.length === 0
      ? null
      : 'its authorization covers calls a withdrawal does not make';
  }
  return depositTransfersRefusal(subs, expected);
}

/**
 * A deposit's authorization may cover only the vault pulling the deposit from
 * the caller: `transfer(caller, vault, x)` on at most one token per asset, never
 * the vault's own, with no calls under it and no more than was requested.
 */
function depositTransfersRefusal(
  subs: AuthorizedInvocation[],
  expected: Extract<ExpectedDefindexCall, { kind: 'deposit' }>,
): string | null {
  if (subs.length > expected.amounts.length) {
    return 'its authorization covers more transfers than assets';
  }
  const ceiling = expected.amounts.reduce((a, b) => (a > b ? a : b), 0n);
  const requested = expected.amounts.reduce((a, b) => a + b, 0n);
  const tokens = new Set<string>();
  let total = 0n;
  for (const sub of subs) {
    const transfer = contractCallOf(sub.function?.contractFn);
    if (
      sub.function?.type !== 'sorobanAuthorizedFunctionTypeContractFn' ||
      !transfer ||
      transfer.function !== 'transfer' ||
      transfer.args.length !== 3 ||
      (sub.subInvocations ?? []).length > 0
    ) {
      return 'its authorization covers a call that is not a deposit transfer';
    }
    const [from, to, amountArg] = transfer.args;
    const amount = amountArg.type === 'scvI128' ? native(amountArg) : null;
    if (
      addressOf(from) !== expected.caller ||
      addressOf(to) !== expected.vault ||
      transfer.contract === expected.vault ||
      tokens.has(transfer.contract) ||
      typeof amount !== 'bigint' ||
      amount < 0n ||
      amount > ceiling
    ) {
      return 'its authorization covers a transfer the deposit did not ask for';
    }
    tokens.add(transfer.contract);
    total += amount;
  }
  return total > requested
    ? 'its authorization covers more than the requested amounts'
    : null;
}

/** An `InvokeContractArgs` read as plain data, or null when it is not one. */
function contractCallOf(value: unknown): ContractCall | null {
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

function scAddressText(address: xdr.ScAddress): string | null {
  try {
    return Address.fromScAddress(address).toString();
  } catch {
    return null;
  }
}

/** The address an argument names, or null when it is not an address. */
function addressOf(value: xdr.ScVal): string | null {
  if (value.type !== 'scvAddress') return null;
  const decoded = native(value);
  return typeof decoded === 'string' ? decoded : null;
}

/** A `Vec<i128>` argument as bigints, or null when it is anything else. */
function i128List(value: xdr.ScVal): bigint[] | null {
  const items = (value as unknown as { vec?: xdr.ScVal[] | null }).vec;
  if (value.type !== 'scvVec' || !Array.isArray(items)) return null;
  const amounts: bigint[] = [];
  for (const item of items) {
    const amount = item.type === 'scvI128' ? native(item) : null;
    if (typeof amount !== 'bigint') return null;
    amounts.push(amount);
  }
  return amounts;
}

function native(value: xdr.ScVal): unknown {
  try {
    return scValToNative(value) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether two argument lists serialize to the same bytes. */
function sameXdr(a: xdr.ScVal[], b: xdr.ScVal[]): boolean {
  return (
    a.length === b.length &&
    a.every((value, i) => value.toXDR('base64') === b[i].toXDR('base64'))
  );
}

function sameList(value: readonly bigint[], amounts: readonly bigint[]) {
  return (
    value.length === amounts.length &&
    value.every((amount, i) => amount === amounts[i])
  );
}

/**
 * The lowest minimum `slippageBps` allows for `amount`: `amount` less the
 * slippage, rounded down, less one unit for a provider that rounds through a
 * float. Never below zero.
 */
function slippageFloor(amount: bigint, slippageBps: number): bigint {
  const floor = (amount * (BPS - BigInt(slippageBps))) / BPS - 1n;
  return floor > 0n ? floor : 0n;
}
