import {
  Address,
  hash,
  StrKey,
  type Transaction,
  xdr,
} from '@stellar/stellar-sdk';
import type { ProtectedPaymentAction } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  TRUSTLESS_WORK_DEPLOY_FN,
  TRUSTLESS_WORK_INIT_FN,
  TRUSTLESS_WORK_MAX_STATUS_LENGTH,
} from '@/native-plugins/trustless-work/trustless-work.constants';
import {
  addressOf,
  type AuthorizedInvocation,
  type BuiltEnvelopeLimits,
  checkSingleContractCall,
  contractCallOf,
  rootAuthorizationRefusal,
  rootSubInvocations,
  scNative,
} from '@/stellar/soroban-envelope';

/**
 * The rules an envelope Trustless Work built is held to before this service
 * records it for a submit, or signs it with one of its own keys. Pure: the
 * tables, the provider calls and the keys are the services'.
 *
 * Trustless Work's V1 contract is called an escrow in its own code
 * (`tw_new_single_release_escrow`, `fund_escrow`, the `Escrow` struct), and this
 * file speaks its vocabulary where it decodes it.
 */

/** The six roles of the contract, as its `Roles` struct holds them. */
export interface ContractRoles {
  approver: string;
  serviceProvider: string;
  platform: string;
  releaseSigner: string;
  disputeResolver: string;
  receiver: string;
}

/**
 * The `Escrow` struct a protected payment's contract must hold: what the deploy
 * initializes it with, and what a fund's `expected_escrow` must equal.
 */
export interface ExpectedContract {
  /** The protected payment's id (`engagement_id`). */
  engagementId: string;
  title: string;
  description: string;
  roles: ContractRoles;
  /** In the token's minor units (7 decimals for USDC). */
  amount: bigint;
  platformFeeBps: number;
  milestoneDescription: string;
  /** The token contract (C...): USDC's Stellar Asset Contract on the network. */
  token: string;
}

/** One distribution of a resolution, in the token's minor units. */
export interface Distribution {
  address: string;
  amount: bigint;
}

/** What a build was asked for: the one call its envelope must make. */
export type ExpectedTrustlessWorkCall =
  | {
      action: 'DEPLOY';
      signer: string;
      contract: ExpectedContract;
      /** Optional pins; empty strings accept any (and the caller logs them). */
      pins: { deployer: string; wasmHash: string };
    }
  | {
      action: 'FUND';
      signer: string;
      contractId: string;
      contract: ExpectedContract;
      amount: bigint;
    }
  | {
      action: 'SHIP';
      signer: string;
      contractId: string;
      milestoneIndex: number;
      status: string;
      evidence: string;
    }
  | {
      action: 'APPROVE';
      signer: string;
      contractId: string;
      milestoneIndex: number;
    }
  | { action: 'RELEASE'; signer: string; contractId: string }
  | { action: 'DISPUTE'; signer: string; contractId: string }
  | {
      action: 'RESOLVE';
      signer: string;
      contractId: string;
      /** The decided split, exactly. */
      distributions: readonly Distribution[];
      /** The only addresses a resolution may pay. */
      parties: { buyer: string; merchant: string };
      /** The contract's balance: the distributions must add up to it. */
      balance: bigint;
    };

/** What a checked deploy establishes, independently of Trustless Work's answer. */
export interface DeployFacts {
  /** The deployer contract the envelope calls. */
  deployer: string;
  /** The wasm it installs, hex. */
  wasmHash: string;
  /** The contract the deploy creates: derived from the deployer and the salt. */
  contractId: string;
}

export type TrustlessWorkEnvelopeCheck =
  | { ok: true; tx: Transaction; deploy?: DeployFacts }
  | { ok: false; reason: string };

/** The contract function each action calls. */
export const ACTION_FUNCTIONS: Record<ProtectedPaymentAction, string> = {
  DEPLOY: TRUSTLESS_WORK_DEPLOY_FN,
  FUND: 'fund_escrow',
  SHIP: 'change_milestone_status',
  APPROVE: 'approve_milestone',
  RELEASE: 'release_funds',
  DISPUTE: 'dispute_escrow',
  RESOLVE: 'resolve_dispute',
};

/**
 * Whether the unsigned envelope Trustless Work built is exactly the call that
 * was asked for, and nothing a compromised or buggy provider could slip in.
 * In this order:
 *
 *  1. the checks every built envelope passes (`checkSingleContractCall`): a
 *     plain v1 transaction whose source is the expected signer, no memo, time
 *     bounds within `maxValidityMs`, Soroban resources and a fee within
 *     `maxFeeStroops`, one contract call sourced by the signer or nobody;
 *  2. the contract: the protected payment's own for every action but the
 *     deploy, which calls Trustless Work's deployer (the pinned one when set);
 *  3. the function and its arguments, per action (see the per-action checks);
 *  4. ONE authorization entry, the signer's, rooted at exactly that call, with
 *     nothing under it, except a fund, whose root covers exactly one call: the
 *     token's `transfer(buyer, contractId, amount)`.
 *
 * A refusal names its reason; the caller logs it and answers
 * `502 provider_error` ({@link builtEnvelopeRefused}).
 */
export function checkTrustlessWorkEnvelope(
  envelope: string,
  passphrase: string,
  expected: ExpectedTrustlessWorkCall,
  limits: BuiltEnvelopeLimits,
): TrustlessWorkEnvelopeCheck {
  const refuse = (reason: string): TrustlessWorkEnvelopeCheck => ({
    ok: false,
    reason,
  });

  const single = checkSingleContractCall(
    envelope,
    passphrase,
    expected.signer,
    limits,
  );
  if (!single.ok) return refuse(single.reason);
  const { tx, call, auth } = single;

  if (expected.action === 'DEPLOY') {
    if (expected.pins.deployer && call.contract !== expected.pins.deployer) {
      return refuse('it calls another deployer than the pinned one');
    }
  } else if (call.contract !== expected.contractId) {
    return refuse('it calls another contract');
  }
  const fn = ACTION_FUNCTIONS[expected.action];
  if (call.function !== fn) return refuse(`it calls ${call.function}`);

  let deploy: DeployFacts | undefined;
  let args: string | null;
  switch (expected.action) {
    case 'DEPLOY': {
      const checked = deployArgs(
        call.args,
        call.contract,
        expected,
        passphrase,
      );
      if (typeof checked === 'string') return refuse(checked);
      deploy = checked;
      args = null;
      break;
    }
    case 'FUND':
      args = fundArgsRefusal(call.args, expected);
      break;
    case 'SHIP':
      args = shipArgsRefusal(call.args, expected);
      break;
    case 'APPROVE':
      args = approveArgsRefusal(call.args, expected);
      break;
    case 'RELEASE':
    case 'DISPUTE':
      args = singleAddressRefusal(call.args, expected.signer);
      break;
    case 'RESOLVE':
      args = resolveArgsRefusal(call.args, expected);
      break;
  }
  if (args) return refuse(args);

  const root = rootAuthorizationRefusal(auth, expected.signer, call);
  if (root) return refuse(root);
  const subs = rootSubInvocations(auth);
  if (expected.action === 'FUND') {
    const transfer = fundTransferRefusal(subs, expected);
    if (transfer) return refuse(transfer);
  } else if (subs.length > 0) {
    return refuse('its authorization covers calls this action does not make');
  }

  return { ok: true, tx, ...(deploy ? { deploy } : {}) };
}

/** The `502 provider_error` a refused build answers. */
export function builtEnvelopeRefused(
  action: ProtectedPaymentAction,
  reason: string,
): ApiError {
  return ApiError.badGateway(
    ApiErrorCode.ProviderError,
    `The protected-payments service built a transaction that is not the requested ` +
      `${action.toLowerCase()}: ${reason}`,
  );
}

/**
 * The contract a deployer creates with `salt`: `deploy_v2` from the deployer's
 * own address, so the id is SHA-256 over the network id, the deployer and the
 * salt (the protocol's `HashIdPreimage::ContractId`). Derived here so the id the
 * buyer pays into never rests on Trustless Work's word.
 */
export function deployedContractId(
  deployer: string,
  salt: Buffer,
  passphrase: string,
): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(passphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: new Address(deployer).toScAddress(),
          salt,
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

// ── Per-action arguments ──────────────────────────────────────────────────

/**
 * `tw_new_single_release_escrow(signer, wasm_hash, salt, init_fn, init_args,
 * constructor_args)`: the platform signs, the new contract is initialized with
 * `initialize_escrow` and EXACTLY the expected `Escrow`, and its constructor
 * takes nothing (the V1 contract's `__constructor` has no parameters).
 */
function deployArgs(
  args: xdr.ScVal[],
  deployer: string,
  expected: Extract<ExpectedTrustlessWorkCall, { action: 'DEPLOY' }>,
  passphrase: string,
): DeployFacts | string {
  if (args.length !== 6) return 'its deploy does not take six arguments';
  const [signer, wasmArg, saltArg, initFn, initArgs, constructorArgs] = args;
  if (addressOf(signer) !== expected.signer) {
    return 'its deploy is not signed by the platform';
  }
  const wasm = bytes32(wasmArg);
  if (!wasm) return 'its wasm hash is not 32 bytes';
  const wasmHash = wasm.toString('hex');
  if (expected.pins.wasmHash && wasmHash !== expected.pins.wasmHash) {
    return 'it installs another wasm than the pinned one';
  }
  const salt = bytes32(saltArg);
  if (!salt) return 'its salt is not 32 bytes';
  if (
    initFn.type !== 'scvSymbol' ||
    String(initFn.sym) !== TRUSTLESS_WORK_INIT_FN
  ) {
    return `its init function is not ${TRUSTLESS_WORK_INIT_FN}`;
  }
  const init = vecOf(initArgs);
  if (!init || init.length !== 1) {
    return 'its init arguments are not the one contract struct';
  }
  const ctor = vecOf(constructorArgs);
  if (!ctor || ctor.length !== 0) return 'it passes constructor arguments';
  const mismatch = contractMismatch(init[0], expected.contract, 'initialized');
  if (mismatch) return mismatch;
  return {
    deployer,
    wasmHash,
    contractId: deployedContractId(deployer, salt, passphrase),
  };
}

/** `fund_escrow(signer, expected_escrow, amount)`, from the buyer, exactly. */
function fundArgsRefusal(
  args: xdr.ScVal[],
  expected: Extract<ExpectedTrustlessWorkCall, { action: 'FUND' }>,
): string | null {
  if (args.length !== 3) return 'its fund does not take three arguments';
  const [signer, contract, amount] = args;
  if (addressOf(signer) !== expected.signer) {
    return 'its fund is not from the buyer';
  }
  const mismatch = contractMismatch(contract, expected.contract, 'expected');
  if (mismatch) return mismatch;
  if (i128(amount) !== expected.amount) {
    return 'its amount differs from the protected payment';
  }
  return null;
}

/** `change_milestone_status(0, status, Some(evidence), service_provider)`. */
function shipArgsRefusal(
  args: xdr.ScVal[],
  expected: Extract<ExpectedTrustlessWorkCall, { action: 'SHIP' }>,
): string | null {
  if (args.length !== 4) {
    return 'its milestone change does not take four arguments';
  }
  const [index, status, evidence, provider] = args;
  if (u32(index) !== expected.milestoneIndex) {
    return 'it changes another milestone';
  }
  if (text(status) !== expected.status) {
    return 'it writes another milestone status';
  }
  if (text(evidence) !== expected.evidence) {
    return 'it writes other evidence than the request';
  }
  if (addressOf(provider) !== expected.signer) {
    return 'its service provider is not the merchant';
  }
  return null;
}

/** `approve_milestone(0, approver)`. */
function approveArgsRefusal(
  args: xdr.ScVal[],
  expected: Extract<ExpectedTrustlessWorkCall, { action: 'APPROVE' }>,
): string | null {
  if (args.length !== 2) return 'its approval does not take two arguments';
  const [index, approver] = args;
  if (u32(index) !== expected.milestoneIndex) {
    return 'it approves another milestone';
  }
  if (addressOf(approver) !== expected.signer) {
    return 'its approver is not the signer';
  }
  return null;
}

/** `release_funds(release_signer)` and `dispute_escrow(signer)`. */
function singleAddressRefusal(
  args: xdr.ScVal[],
  signer: string,
): string | null {
  if (args.length !== 1) return 'it does not take one argument';
  return addressOf(args[0]) === signer
    ? null
    : 'its address argument is not the signer';
}

/**
 * `resolve_dispute(dispute_resolver, distributions)`. The contract lets a
 * resolver pay ANY address, so this is the guard that keeps a resolution to
 * the protected payment's own buyer and merchant: every key one of the two,
 * every amount positive (the contract refuses zero), each exactly the decided
 * split, and the sum exactly the contract's balance.
 */
function resolveArgsRefusal(
  args: xdr.ScVal[],
  expected: Extract<ExpectedTrustlessWorkCall, { action: 'RESOLVE' }>,
): string | null {
  if (args.length !== 2) return 'its resolution does not take two arguments';
  const [resolver, mapArg] = args;
  if (addressOf(resolver) !== expected.signer) {
    return 'its resolver is not the signer';
  }
  const entries = (mapArg as unknown as { map?: xdr.ScMapEntry[] | null }).map;
  if (mapArg.type !== 'scvMap' || !Array.isArray(entries)) {
    return 'its distributions are not a map';
  }
  const allowed = new Set([expected.parties.buyer, expected.parties.merchant]);
  const paid = new Map<string, bigint>();
  let total = 0n;
  for (const entry of entries) {
    const address = addressOf(entry.key);
    const amount = i128(entry.val);
    if (!address || amount === null) {
      return 'its distributions are not addresses to amounts';
    }
    if (!allowed.has(address)) {
      return 'it pays an address that is neither the buyer nor the merchant';
    }
    if (amount <= 0n) return 'it distributes a non-positive amount';
    if (paid.has(address)) return 'it pays one address twice';
    paid.set(address, amount);
    total += amount;
  }
  const decided = expected.distributions.filter((d) => d.amount > 0n);
  if (
    paid.size !== decided.length ||
    decided.some((d) => paid.get(d.address) !== d.amount)
  ) {
    return 'its distributions differ from the decided split';
  }
  if (total !== expected.balance) {
    return 'its distributions do not add up to the balance';
  }
  return null;
}

/**
 * A fund's authorization covers exactly one call under the root: the token
 * pulling the amount from the buyer into the contract, with nothing under it.
 */
function fundTransferRefusal(
  subs: AuthorizedInvocation[],
  expected: Extract<ExpectedTrustlessWorkCall, { action: 'FUND' }>,
): string | null {
  if (subs.length !== 1) {
    return 'its authorization does not cover exactly one transfer';
  }
  const [sub] = subs;
  const transfer = contractCallOf(sub.function?.contractFn);
  if (
    sub.function?.type !== 'sorobanAuthorizedFunctionTypeContractFn' ||
    !transfer ||
    transfer.contract !== expected.contract.token ||
    transfer.function !== 'transfer' ||
    transfer.args.length !== 3 ||
    (sub.subInvocations ?? []).length > 0
  ) {
    return 'its authorization covers a call that is not the deposit transfer';
  }
  const [from, to, amount] = transfer.args;
  if (
    addressOf(from) !== expected.signer ||
    addressOf(to) !== expected.contractId ||
    i128(amount) !== expected.amount
  ) {
    return 'its authorization covers a transfer the fund did not ask for';
  }
  return null;
}

// ── The contract struct ───────────────────────────────────────────────────

/** The `Escrow` struct as this check reads it, every field typed. */
interface DecodedContract {
  engagementId: string;
  title: string;
  description: string;
  roles: ContractRoles;
  amount: bigint;
  platformFeeBps: number;
  milestones: {
    description: string;
    status: string;
    evidence: string;
    approved: boolean;
  }[];
  flags: { disputed: boolean; released: boolean; resolved: boolean };
  token: string;
  receiverMemo: number;
}

const CONTRACT_FIELDS = [
  'amount',
  'description',
  'engagement_id',
  'flags',
  'milestones',
  'platform_fee',
  'receiver_memo',
  'roles',
  'title',
  'trustline',
];
const ROLE_FIELDS = [
  'approver',
  'dispute_resolver',
  'platform',
  'receiver',
  'release_signer',
  'service_provider',
];
const MILESTONE_FIELDS = ['approved', 'description', 'evidence', 'status'];
const FLAG_FIELDS = ['disputed', 'released', 'resolved'];

/**
 * Why `value` is not the contract `expected` describes, or null when it is.
 * Strict on everything that decides where money goes (roles, amount, fee,
 * token, flags, approval) and on everything this service sent; tolerant on the
 * one string Trustless Work writes itself, the milestone's initial status,
 * which the V1 docs spell two ways and which moves nothing.
 */
export function contractMismatch(
  value: xdr.ScVal,
  expected: ExpectedContract,
  which: 'initialized' | 'expected',
): string | null {
  const decoded = decodeContract(value);
  const label = `its ${which} contract`;
  if (!decoded) return `${label} is not a single-release contract struct`;
  if (decoded.engagementId !== expected.engagementId) {
    return `${label} names another engagement id`;
  }
  if (
    decoded.title !== expected.title ||
    decoded.description !== expected.description
  ) {
    return `${label} has another title or description`;
  }
  const roles = Object.keys(expected.roles) as (keyof ContractRoles)[];
  for (const role of roles) {
    if (decoded.roles[role] !== expected.roles[role]) {
      return `${label} has another ${role}`;
    }
  }
  if (decoded.amount !== expected.amount) return `${label} has another amount`;
  if (decoded.platformFeeBps !== expected.platformFeeBps) {
    return `${label} has another platform fee`;
  }
  if (decoded.token !== expected.token) {
    return `${label} holds another token`;
  }
  if (decoded.receiverMemo !== 0) return `${label} sets a receiver memo`;
  if (
    decoded.flags.disputed ||
    decoded.flags.released ||
    decoded.flags.resolved
  ) {
    return `${label} has a flag set`;
  }
  if (decoded.milestones.length !== 1) {
    return `${label} does not have exactly one milestone`;
  }
  const [milestone] = decoded.milestones;
  if (
    milestone.description !== expected.milestoneDescription ||
    milestone.evidence !== '' ||
    milestone.approved ||
    milestone.status.length > TRUSTLESS_WORK_MAX_STATUS_LENGTH
  ) {
    return `${label} has another milestone`;
  }
  return null;
}

function decodeContract(value: xdr.ScVal): DecodedContract | null {
  const fields = structOf(value, CONTRACT_FIELDS);
  if (!fields) return null;
  const roles = structOf(fields.get('roles')!, ROLE_FIELDS);
  const flags = structOf(fields.get('flags')!, FLAG_FIELDS);
  const trustline = structOf(fields.get('trustline')!, ['address']);
  const milestones = vecOf(fields.get('milestones')!);
  if (!roles || !flags || !trustline || !milestones) return null;

  const decodedRoles: ContractRoles = {
    approver: addressOf(roles.get('approver')!) ?? '',
    serviceProvider: addressOf(roles.get('service_provider')!) ?? '',
    platform: addressOf(roles.get('platform')!) ?? '',
    releaseSigner: addressOf(roles.get('release_signer')!) ?? '',
    disputeResolver: addressOf(roles.get('dispute_resolver')!) ?? '',
    receiver: addressOf(roles.get('receiver')!) ?? '',
  };
  if (Object.values(decodedRoles).some((address) => address === '')) {
    return null;
  }

  const decodedMilestones: DecodedContract['milestones'] = [];
  for (const item of milestones) {
    const m = structOf(item, MILESTONE_FIELDS);
    const description = m && text(m.get('description')!);
    const status = m && text(m.get('status')!);
    const evidence = m && text(m.get('evidence')!);
    const approved = m && bool(m.get('approved')!);
    if (
      description === null ||
      status === null ||
      evidence === null ||
      approved === null
    ) {
      return null;
    }
    decodedMilestones.push({ description, status, evidence, approved });
  }

  const engagementId = text(fields.get('engagement_id')!);
  const title = text(fields.get('title')!);
  const description = text(fields.get('description')!);
  const amount = i128(fields.get('amount')!);
  const platformFeeBps = u32(fields.get('platform_fee')!);
  const receiverMemo = u32(fields.get('receiver_memo')!);
  const token = addressOf(trustline.get('address')!);
  const disputed = bool(flags.get('disputed')!);
  const released = bool(flags.get('released')!);
  const resolved = bool(flags.get('resolved')!);
  if (
    engagementId === null ||
    title === null ||
    description === null ||
    amount === null ||
    platformFeeBps === null ||
    receiverMemo === null ||
    token === null ||
    disputed === null ||
    released === null ||
    resolved === null
  ) {
    return null;
  }
  return {
    engagementId,
    title,
    description,
    roles: decodedRoles,
    amount,
    platformFeeBps,
    milestones: decodedMilestones,
    flags: { disputed, released, resolved },
    token,
    receiverMemo,
  };
}

/**
 * A `#[contracttype]` struct: an `ScMap` keyed by symbols, with exactly
 * `fields` (no more, no fewer, none twice). Null for anything else.
 */
function structOf(
  value: xdr.ScVal,
  fields: readonly string[],
): Map<string, xdr.ScVal> | null {
  const entries = (value as unknown as { map?: xdr.ScMapEntry[] | null }).map;
  if (value.type !== 'scvMap' || !Array.isArray(entries)) return null;
  const out = new Map<string, xdr.ScVal>();
  for (const entry of entries) {
    if (entry.key.type !== 'scvSymbol') return null;
    const key = String((entry.key as unknown as { sym: unknown }).sym);
    if (out.has(key)) return null;
    out.set(key, entry.val);
  }
  if (out.size !== fields.length || fields.some((f) => !out.has(f))) {
    return null;
  }
  return out;
}

function vecOf(value: xdr.ScVal): xdr.ScVal[] | null {
  const items = (value as unknown as { vec?: xdr.ScVal[] | null }).vec;
  return value.type === 'scvVec' && Array.isArray(items) ? items : null;
}

/** A `String` (`scvString`), or null. */
function text(value: xdr.ScVal): string | null {
  if (value.type !== 'scvString') return null;
  const decoded = scNative(value);
  return typeof decoded === 'string' ? decoded : null;
}

function i128(value: xdr.ScVal): bigint | null {
  if (value.type !== 'scvI128') return null;
  const decoded = scNative(value);
  return typeof decoded === 'bigint' ? decoded : null;
}

function u32(value: xdr.ScVal): number | null {
  if (value.type !== 'scvU32') return null;
  const decoded = scNative(value);
  return typeof decoded === 'number' ? decoded : null;
}

function bool(value: xdr.ScVal): boolean | null {
  if (value.type !== 'scvBool') return null;
  const decoded = scNative(value);
  return typeof decoded === 'boolean' ? decoded : null;
}

/** A `BytesN<32>`, or null. */
function bytes32(value: xdr.ScVal): Buffer | null {
  if (value.type !== 'scvBytes') return null;
  const decoded = scNative(value);
  if (!(decoded instanceof Uint8Array)) return null;
  const buffer = Buffer.from(decoded);
  return buffer.length === 32 ? buffer : null;
}
