import { type Transaction, type xdr } from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { DEFINDEX_MAX_VAULT_ASSETS } from '@/native-plugins/defindex/defindex.constants';
import {
  addressOf,
  type AuthorizedInvocation,
  type BuiltEnvelopeLimits,
  checkSingleContractCall,
  contractCallOf,
  rootAuthorizationRefusal,
  rootSubInvocations,
  scNative as native,
} from '@/stellar/soroban-envelope';

// The envelope rules shared with the other plugins that relay what they build
// live in `@/stellar/soroban-envelope`; these are re-exported so the DeFindex
// services keep one import for everything about their envelopes.
export {
  type BuiltEnvelopeLimits,
  signedEnvelope,
  submittableUntil,
  transactionHash,
} from '@/stellar/soroban-envelope';

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

export type BuiltEnvelopeCheck =
  { ok: true; tx: Transaction } | { ok: false; reason: string };

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

  const single = checkSingleContractCall(
    envelope,
    passphrase,
    expected.caller,
    limits,
  );
  if (!single.ok) return refuse(single.reason);
  const { tx, call, auth } = single;
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

  const authorization = authRefusal(auth, call, expected);
  if (authorization) return refuse(authorization);

  return { ok: true, tx };
}

/** The `502 provider_error` a refused build answers. */
export function builtEnvelopeRefused(
  kind: ExpectedDefindexCall['kind'],
  reason: string,
): ApiError {
  return ApiError.badGateway(
    ApiErrorCode.ProviderError,
    `The vault protocol built a transaction that is not the requested ${kind}: ${reason}`,
  );
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
  entries: Parameters<typeof rootAuthorizationRefusal>[0],
  call: Parameters<typeof rootAuthorizationRefusal>[2],
  expected: ExpectedDefindexCall,
): string | null {
  const root = rootAuthorizationRefusal(entries, expected.caller, call);
  if (root) return root;

  const subs = rootSubInvocations(entries);
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
