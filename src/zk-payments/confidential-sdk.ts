import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Injectable, Logger } from '@nestjs/common';
import {
  Address,
  FeeBumpTransaction,
  humanizeEvents,
  rpc,
  scValToNative,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import type * as ConfidentialSdkTypes from 'stellar-confidential-token-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { ZkNetworkConfig } from '@/config/configuration';
import {
  CONFIDENTIAL_TRANSFER_EVENT,
  CONFIDENTIAL_TRANSFER_FUNCTION,
  ZK_RPC_TIMEOUT_MS,
} from '@/zk-payments/zk-payments.constants';

/**
 * THE one module that loads `stellar-confidential-token-sdk`.
 *
 * The SDK is an ES module (`"type": "module"`, an `exports` map with only an
 * `import` condition) and this service compiles to CommonJS, where TypeScript
 * rewrites `import()` into `require()`, which that `exports` map refuses. So the
 * import is a real dynamic `import()` built at runtime, out of TypeScript's
 * reach, and it is the only place that does so: everything else in the module
 * talks to {@link ConfidentialSdk} with plain data (strings, bigints, dates), so
 * its specs mock this class and never load the SDK, whose ESM dependencies the
 * jest runtime cannot load either.
 *
 * Proving (`bb.js`) is never needed here. The SDK loads it lazily, only when a
 * proof is generated, which only the scripts under `scripts/zk/` do.
 */

/** The SDK's module namespace, for the scripts that need more than this class. */
export type ConfidentialSdkModule = typeof ConfidentialSdkTypes;

/**
 * A dynamic `import()` TypeScript cannot rewrite into `require()`.
 *
 * `new Function` is the standard escape hatch for loading an ES module from
 * CommonJS output. Its body is a constant, and the URL it is given is built by
 * {@link sdkEntryUrl} from the installed package, never from input.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importEsm = new Function('url', 'return import(url)') as (
  url: string,
) => Promise<unknown>;

const SDK_SPECIFIER = 'stellar-confidential-token-sdk';

/**
 * The `file://` URL of one of the SDK's `exports` entries, found from THIS
 * file's location the way `require` searches.
 *
 * An `import()` built with `new Function` resolves a bare specifier against the
 * process's working directory, not against this module: importing
 * `stellar-confidential-token-sdk` worked from the repository root and failed
 * with `ERR_MODULE_NOT_FOUND` from anywhere else. `require.resolve` cannot help
 * either, because the package exports nothing under the `require` condition.
 * So the package directory is found on `require`'s own search path, and its
 * `exports` map is read for the `import` target.
 */
function sdkEntryUrl(subpath: '.' | './proving/artifacts'): string {
  for (const dir of require.resolve.paths(SDK_SPECIFIER) ?? []) {
    const packageDir = join(dir, SDK_SPECIFIER);
    const manifest = join(packageDir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
      exports?: Record<string, { import?: string } | string | undefined>;
    };
    const entry = pkg.exports?.[subpath];
    const target = typeof entry === 'string' ? entry : entry?.import;
    if (!target) break;
    return pathToFileURL(join(packageDir, target)).href;
  }
  throw new Error(
    `${SDK_SPECIFIER} (${subpath}) is not installed: run npm ci.`,
  );
}

let sdkModule: Promise<ConfidentialSdkModule> | undefined;

/**
 * The SDK, loaded once per process (about 1 s and 36 MB the first time).
 * Exported for `scripts/zk/*`, which prove, deploy and register.
 */
export function loadConfidentialSdk(): Promise<ConfidentialSdkModule> {
  sdkModule ??= (
    Promise.resolve().then(() =>
      importEsm(sdkEntryUrl('.')),
    ) as Promise<ConfidentialSdkModule>
  ).catch((err: unknown) => {
    sdkModule = undefined;
    throw err;
  });
  return sdkModule;
}

/** The circuits the SDK proves with, by name (`circuits/<name>.json`). */
export type ConfidentialCircuitName =
  | 'register'
  | 'withdraw'
  | 'transfer'
  | 'set_spender'
  | 'spender_transfer'
  | 'clawback';

/**
 * The SDK's Node-only circuit loader (`stellar-confidential-token-sdk/proving/
 * artifacts`). Typed here because this repo resolves modules the `node10` way,
 * which does not read a package's `exports` map, so TypeScript cannot see the
 * subpath's own declarations.
 */
export interface ConfidentialSdkArtifacts {
  loadCircuit(
    name: ConfidentialCircuitName,
  ): ConstructorParameters<ConfidentialSdkModule['CircuitProver']>[0];
}

let artifactsModule: Promise<ConfidentialSdkArtifacts> | undefined;

/**
 * The circuit loader, for `scripts/zk/*` only: the server never proves, so it
 * never loads circuits (or `bb.js`).
 */
export function loadConfidentialSdkArtifacts(): Promise<ConfidentialSdkArtifacts> {
  artifactsModule ??= (
    Promise.resolve().then(() =>
      importEsm(sdkEntryUrl('./proving/artifacts')),
    ) as Promise<ConfidentialSdkArtifacts>
  ).catch((err: unknown) => {
    artifactsModule = undefined;
    throw err;
  });
  return artifactsModule;
}

/** The contracts and the RPC of one network's confidential token. */
export type ZkChainTarget = Pick<
  ZkNetworkConfig,
  'rpcUrl' | 'networkPassphrase' | 'token' | 'auditorRegistry' | 'verifier'
>;

/** An address's confidential account on the token, as far as a payment cares. */
export interface ConfidentialAccountInfo {
  registered: boolean;
  /** The auditor the account registered under; null when not registered. */
  auditorId: number | null;
}

/** One `transfer` event of the token, decrypted with the auditor secret. */
export interface ZkAuditedTransfer {
  from: string;
  to: string;
  /**
   * The amount in stroops, from the recipient-auditor channel; null when the
   * event could not be decoded (a malformed point or field).
   */
  amount: bigint | null;
  /**
   * The sender-auditor channel decrypts to the same amount. Under the right key
   * it must: the circuit binds both channels to one `v_transfer`. False means
   * the secret is not the auditor key of both parties.
   */
  channelsAgree: boolean;
  /**
   * `commit(amount, r_transfer)` equals the `C_transfer` the invocation added to
   * the recipient's receiving balance. Null when the transaction's invocation
   * is not a direct `confidential_transfer` carrying one for this pair.
   */
  commitmentMatches: boolean | null;
}

/** What one operation of the transaction invoked. */
export interface ZkInvocation {
  contract: string;
  function: string;
}

export type ZkTransactionRead =
  | { status: 'not_found'; txHash: string }
  | { status: 'failed'; txHash: string; ledger: number; closedAt: Date }
  | {
      status: 'success';
      txHash: string;
      ledger: number;
      /** The ledger's close time: the instant the transfer happened. */
      closedAt: Date;
      /** Operations in the transaction. A confidential transfer is one. */
      operationCount: number;
      /** The invocation of the first operation, or null when it calls no contract. */
      invocation: ZkInvocation | null;
      /** Every `transfer` event the token emitted in the transaction. */
      transfers: ZkAuditedTransfer[];
    };

/** The plain view `humanizeEvents` gives of one contract event. */
interface HumanEvent {
  contractId?: string;
  topics: unknown[];
  data: unknown;
}

/**
 * The confidential token, as the server needs it: is an address registered,
 * and what did a transaction transfer, decrypted.
 *
 * Every RPC it talks to is checked first: before the first read of a target,
 * the node's network passphrase must be the configured one, the way
 * `SolanaRpcClient` checks a genesis hash. A testnet RPC answering for a mainnet
 * configuration (or the reverse) would verify transfers on the wrong ledger.
 */
@Injectable()
export class ConfidentialSdk {
  private readonly logger = new Logger(ConfidentialSdk.name);
  private readonly networkChecks = new Map<string, Promise<void>>();

  /**
   * Whether `address` holds a confidential account on the token, and under
   * which auditor id. Read with the SDK's `ChainClient`: only the contract's
   * `AccountNotRegistered` answer is "not registered"; anything else
   * (transport, an archived entry) is an upstream failure, never a "no".
   */
  async account(
    target: ZkChainTarget,
    address: string,
  ): Promise<ConfidentialAccountInfo> {
    await this.assertNetwork(target);
    const sdk = await this.sdk();
    const client = new sdk.ChainClient({
      rpcUrl: target.rpcUrl,
      networkPassphrase: target.networkPassphrase,
      contracts: {
        token: target.token,
        verifier: target.verifier,
        auditor: target.auditorRegistry,
      },
    });
    const account = await this.upstream('confidential_balance', () =>
      client.confidentialBalance(address),
    );
    return account
      ? { registered: true, auditorId: account.auditorId }
      : { registered: false, auditorId: null };
  }

  /**
   * Reads `txHash` back from the RPC and decrypts every `transfer` event the
   * token emitted in it with `auditorSecretHex` (the auditor scalar `k`).
   *
   * Decides nothing: whether the transfer pays a given payment is
   * `zk-payment-verification.ts`'s call. This only reports, in plain data, what
   * the chain says happened.
   */
  async readTransaction(
    target: ZkChainTarget,
    auditorSecretHex: string,
    txHash: string,
  ): Promise<ZkTransactionRead> {
    await this.assertNetwork(target);
    const server = this.server(target);
    const tx = await this.upstream('getTransaction', () =>
      server.getTransaction(txHash),
    );

    if (tx.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return { status: 'not_found', txHash };
    }
    const closedAt = new Date(tx.createdAt * 1000);
    if (tx.status === rpc.Api.GetTransactionStatus.FAILED) {
      return { status: 'failed', txHash, ledger: tx.ledger, closedAt };
    }

    const envelope = this.innerTransaction(
      tx.envelopeXdr.toXDR('base64'),
      target.networkPassphrase,
    );
    const invocations = envelope.operations.map(invocationOf);
    const firstInvocation = invocations[0] ?? null;
    const commitments = transferCommitments(invocations, target.token);

    if (!tx.events) {
      throw ApiError.unavailable(
        ApiErrorCode.ProviderUnavailable,
        'The Soroban RPC answered without transaction events: it must serve ' +
          'protocol 23 or later.',
      );
    }
    const events = humanizeEvents(
      tx.events.contractEventsXdr.flat(),
    ) as HumanEvent[];

    const sdk = await this.sdk();
    const k = BigInt(`0x${auditorSecretHex}`);
    const transfers = events
      .filter(
        (ev) =>
          ev.contractId === target.token &&
          ev.topics[0] === CONFIDENTIAL_TRANSFER_EVENT,
      )
      .map((ev) =>
        this.auditTransferEvent(sdk, k, ev, {
          txHash,
          ledger: tx.ledger,
          commitments,
        }),
      );

    return {
      status: 'success',
      txHash,
      ledger: tx.ledger,
      closedAt,
      operationCount: envelope.operations.length,
      invocation: firstInvocation
        ? {
            contract: firstInvocation.contract,
            function: firstInvocation.function,
          }
        : null,
      transfers,
    };
  }

  /** Decodes one `transfer` event and opens it with the auditor key. */
  private auditTransferEvent(
    sdk: ConfidentialSdkModule,
    k: bigint,
    ev: HumanEvent,
    context: {
      txHash: string;
      ledger: number;
      commitments: Map<string, Uint8Array>;
    },
  ): ZkAuditedTransfer {
    const from = typeof ev.topics[1] === 'string' ? ev.topics[1] : '';
    const to = typeof ev.topics[2] === 'string' ? ev.topics[2] : '';
    try {
      const parsed = sdk.buildConfidentialEvent(
        CONFIDENTIAL_TRANSFER_EVENT,
        { ledger: context.ledger, txHash: context.txHash, cursor: '' },
        (i) => {
          const topic = ev.topics[i];
          if (typeof topic !== 'string') {
            throw new Error(`transfer event topic ${i} is not an address`);
          }
          return topic;
        },
        nativeDataAccessor(sdk, ev.data),
      );
      if (!parsed || parsed.type !== 'transfer') {
        throw new Error('not a transfer event');
      }
      // The brief's two channels: the recipient's is the amount the merchant
      // receives; the sender's must agree with it under the same key.
      const recipient = sdk.auditTransferRecipientChannel(k, parsed);
      const both = sdk.auditTransfer(k, parsed);
      const cTransfer = context.commitments.get(pairKey(from, to));
      const commitmentMatches = cTransfer
        ? equalBytes(
            sdk.pointToBytes(sdk.commit(recipient.amount, recipient.rTransfer)),
            cTransfer,
          )
        : null;
      return {
        from,
        to,
        amount: recipient.amount,
        channelsAgree: both.channelsAgree && both.amount === recipient.amount,
        commitmentMatches,
      };
    } catch (err) {
      this.logger.warn(
        `Could not decode a transfer event of ${context.txHash}: ${String(err)}`,
      );
      return {
        from,
        to,
        amount: null,
        channelsAgree: false,
        commitmentMatches: null,
      };
    }
  }

  /** The transaction a fee bump wraps, or the transaction itself. */
  private innerTransaction(envelopeXdr: string, passphrase: string) {
    const parsed = TransactionBuilder.fromXDR(envelopeXdr, passphrase);
    return parsed instanceof FeeBumpTransaction
      ? parsed.innerTransaction
      : parsed;
  }

  private server(target: ZkChainTarget): rpc.Server {
    return new rpc.Server(target.rpcUrl, {
      allowHttp: target.rpcUrl.startsWith('http://'),
      timeout: ZK_RPC_TIMEOUT_MS,
    });
  }

  /**
   * Refuses an RPC that serves another network than the one configured. Cached
   * per (url, passphrase) once it passes; a failed check is retried next time.
   */
  private assertNetwork(target: ZkChainTarget): Promise<void> {
    const key = `${target.rpcUrl}\n${target.networkPassphrase}`;
    let check = this.networkChecks.get(key);
    if (!check) {
      check = (async () => {
        const network = await this.upstream('getNetwork', () =>
          this.server(target).getNetwork(),
        );
        if (network.passphrase !== target.networkPassphrase) {
          this.logger.error(
            `Soroban RPC ${target.rpcUrl} serves "${network.passphrase}", ` +
              `not the configured "${target.networkPassphrase}"`,
          );
          throw ApiError.unavailable(
            ApiErrorCode.Misconfigured,
            'The Soroban RPC configured for ZK payments serves another network.',
          );
        }
      })();
      this.networkChecks.set(key, check);
      check.catch(() => this.networkChecks.delete(key));
    }
    return check;
  }

  private sdk(): Promise<ConfidentialSdkModule> {
    return loadConfidentialSdk().catch((err: unknown) => {
      this.logger.error(`Could not load ${SDK_SPECIFIER}: ${String(err)}`);
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'The confidential token SDK could not be loaded on this deployment.',
      );
    });
  }

  /**
   * Runs one RPC call under {@link ZK_RPC_TIMEOUT_MS}, turning a transport
   * failure into `503 provider_unavailable`. An `ApiError` passes through.
   */
  private async upstream<T>(what: string, call: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${ZK_RPC_TIMEOUT_MS} ms`)),
        ZK_RPC_TIMEOUT_MS,
      );
      timer.unref();
    });
    try {
      return await Promise.race([call(), timeout]);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      this.logger.warn(`Soroban RPC ${what} failed: ${String(err)}`);
      throw ApiError.unavailable(
        ApiErrorCode.ProviderUnavailable,
        'The Soroban RPC is unavailable. Retry shortly.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** An operation's contract invocation, with its native arguments. */
interface DecodedInvocation extends ZkInvocation {
  args: unknown[];
}

/** What an operation invoked, or null when it is not a direct contract call. */
function invocationOf(op: {
  type: string;
  func?: unknown;
}): DecodedInvocation | null {
  if (op.type !== 'invokeHostFunction') return null;
  const func = op.func as
    | {
        invokeContract?: {
          contractAddress: unknown;
          functionName: unknown;
          args: xdr.ScVal[];
        };
      }
    | undefined;
  const call = func?.invokeContract;
  if (!call) return null;
  let contract: string;
  try {
    contract = Address.fromScAddress(
      call.contractAddress as xdr.ScAddress,
    ).toString();
  } catch {
    return null;
  }
  return {
    contract,
    function: String(call.functionName),
    args: call.args.map((arg) => {
      try {
        return scValToNative(arg) as unknown;
      } catch {
        return undefined;
      }
    }),
  };
}

/**
 * The `C_transfer` of every direct `confidential_transfer(from, to, data)` on
 * the token, keyed by (from, to). It travels only in the invocation's `data`
 * (`{ payload: { c_transfer, ... }, proof }` as XDR bytes); the event omits it.
 */
function transferCommitments(
  invocations: (DecodedInvocation | null)[],
  token: string,
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const call of invocations) {
    if (
      !call ||
      call.contract !== token ||
      call.function !== CONFIDENTIAL_TRANSFER_FUNCTION
    ) {
      continue;
    }
    const [from, to, data] = call.args;
    if (
      typeof from !== 'string' ||
      typeof to !== 'string' ||
      !(data instanceof Uint8Array)
    ) {
      continue;
    }
    try {
      const envelope = scValToNative(xdr.ScVal.fromXDR(Buffer.from(data))) as {
        payload?: { c_transfer?: unknown };
      };
      const cTransfer = envelope.payload?.c_transfer;
      if (cTransfer instanceof Uint8Array && cTransfer.length === 64) {
        out.set(pairKey(from, to), cTransfer);
      }
    } catch {
      // Not a transfer envelope: no commitment to check against.
    }
  }
  return out;
}

const pairKey = (from: string, to: string) => `${from}>${to}`;

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * The SDK's event accessor over `scValToNative` output: bytes for points and
 * field elements, bigint for i128, number for u32, a strkey for an address.
 */
function nativeDataAccessor(
  sdk: ConfidentialSdkModule,
  data: unknown,
): Parameters<ConfidentialSdkModule['buildConfidentialEvent']>[3] {
  const fields =
    data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const get = (name: string): unknown => {
    const value = fields[name];
    if (value === undefined) {
      throw new Error(`event data missing field "${name}"`);
    }
    return value;
  };
  const bytes = (name: string): Uint8Array => {
    const value = get(name);
    if (!(value instanceof Uint8Array)) {
      throw new Error(`event field "${name}" is not bytes`);
    }
    return value;
  };
  return {
    field: (name) => sdk.fromBytesBE(bytes(name)),
    point: (name) => sdk.pointFromBytes(bytes(name)),
    i128: (name) => BigInt(get(name) as bigint),
    u32: (name) => Number(get(name)),
    bool: (name) => Boolean(get(name)),
    address: (name) => {
      const value = get(name);
      if (
        typeof value !== 'string' ||
        !(
          StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value)
        )
      ) {
        throw new Error(`event field "${name}" is not an address`);
      }
      return value;
    },
    isNone: (name) => fields[name] === undefined || fields[name] === null,
  };
}
