import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decodeBase58 } from '@/chains/chain-address';
import {
  callJsonRpc,
  JsonRpcError,
  type JsonRpcTarget,
  unexpectedRpcError,
} from '@/chains/json-rpc';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig } from '@/config/configuration';
import {
  SANDBOX_NEAR_FINAL_STATUS,
  SANDBOX_NEAR_TESTNET,
} from '@/sandbox-settlement/sandbox-near.constants';

/** An account as `view_account` answers it (yoctoNEAR as bigints). */
export interface NearAccountView {
  amount: bigint;
  locked: bigint;
  storageUsage: bigint;
}

/** Where a transaction stands, as the node knows it. */
export type NearTxState =
  /** The node has never seen it (or no longer has it). */
  | { state: 'unknown' }
  /** Seen, not executed and finalized yet. */
  | { state: 'pending' }
  | { state: 'succeeded' }
  | { state: 'failed'; reason: string };

/** What a broadcast came to. */
export type NearBroadcast =
  /** In a block, executed, or at least accepted for inclusion. */
  | 'accepted'
  /**
   * Refused for good: its block hash is past the validity window (or on no
   * chain this node knows), so these bytes can never be included any more.
   */
  | 'expired';

/** What `query` answers for `call_function`: the method's return, as bytes. */
interface CallFunctionResult {
  result?: number[];
  error?: string;
}

/**
 * JSON-RPC access to NEAR's TEST network for the sandbox. Like
 * `SandboxEvmClient`, it refuses a node on the wrong network: before the first
 * call it compares `status.chain_id` with `SANDBOX_NEAR_TESTNET.chainId`, so a
 * URL pointed at mainnet is a 503, never a payout there. NEAR takes its
 * parameters as one object.
 */
@Injectable()
export class SandboxNearClient {
  private chainCheck: Promise<void> | null = null;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private target(): JsonRpcTarget {
    const settings = this.config.get('sandbox', { infer: true });
    return {
      provider: SANDBOX_NEAR_TESTNET.testnetName,
      url: settings.rpcUrls.near ?? SANDBOX_NEAR_TESTNET.defaultRpcUrl,
      timeoutMs: settings.timeoutMs,
    };
  }

  private assertChain(): Promise<void> {
    if (this.chainCheck) return this.chainCheck;
    const check = callJsonRpc<{ chain_id?: string }>(
      this.target(),
      'status',
      [],
    ).then((status) => {
      if (status.chain_id !== SANDBOX_NEAR_TESTNET.chainId) {
        throw ApiError.misconfigured(
          'The sandbox cannot reach this test network right now.',
          `The sandbox RPC for near serves chain ${String(status.chain_id)}, ` +
            `not ${SANDBOX_NEAR_TESTNET.chainId}: check SANDBOX_RPC_URLS.`,
        );
      }
    });
    this.chainCheck = check;
    check.catch(() => {
      this.chainCheck = null;
    });
    return check;
  }

  /** One call, a JSON-RPC error left as a {@link JsonRpcError}. */
  private async rawCall<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    await this.assertChain();
    return callJsonRpc<T>(this.target(), method, params);
  }

  /** One call, any JSON-RPC error answered as a 502. */
  private async call<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await this.rawCall<T>(method, params);
    } catch (err) {
      throw err instanceof JsonRpcError
        ? unexpectedRpcError(SANDBOX_NEAR_TESTNET.testnetName, method, err)
        : err;
    }
  }

  /** A contract's view method, on the final block, its JSON answer parsed. */
  async view<T>(
    contract: string,
    method: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const answer = await this.call<CallFunctionResult>('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    if (!answer.result) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `${SANDBOX_NEAR_TESTNET.testnetName} could not run ${method}: ${answer.error ?? 'no result'}`,
      );
    }
    return JSON.parse(Buffer.from(answer.result).toString('utf8')) as T;
  }

  /** A NEP-141 balance, in base units (0 for an account the token never saw). */
  async ftBalanceOf(contract: string, account: string): Promise<bigint> {
    const balance = await this.view<string>(contract, 'ft_balance_of', {
      account_id: account,
    });
    return BigInt(balance);
  }

  /** The account's NEP-145 storage with the token; null when it is not registered. */
  async storageBalanceOf(
    contract: string,
    account: string,
  ): Promise<bigint | null> {
    const balance = await this.view<{ total?: string } | null>(
      contract,
      'storage_balance_of',
      { account_id: account },
    );
    return balance?.total === undefined ? null : BigInt(balance.total);
  }

  /** The account's balances; null when the account does not exist (yet). */
  async account(accountId: string): Promise<NearAccountView | null> {
    try {
      const view = await this.rawCall<{
        amount: string;
        locked: string;
        storage_usage: number;
      }>('query', {
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId,
      });
      return {
        amount: BigInt(view.amount),
        locked: BigInt(view.locked),
        storageUsage: BigInt(view.storage_usage),
      };
    } catch (err) {
      if (err instanceof JsonRpcError && err.causeName === 'UNKNOWN_ACCOUNT') {
        return null;
      }
      throw err instanceof JsonRpcError
        ? unexpectedRpcError(SANDBOX_NEAR_TESTNET.testnetName, 'query', err)
        : err;
    }
  }

  /**
   * The access key's current nonce (on the newest block, so a transaction
   * just included counts); null when the account has no such key.
   */
  async accessKeyNonce(
    accountId: string,
    publicKey: string,
  ): Promise<bigint | null> {
    try {
      const view = await this.rawCall<{ nonce?: number | string }>('query', {
        request_type: 'view_access_key',
        finality: 'optimistic',
        account_id: accountId,
        public_key: publicKey,
      });
      return view.nonce === undefined ? null : BigInt(view.nonce);
    } catch (err) {
      if (
        err instanceof JsonRpcError &&
        (err.causeName === 'UNKNOWN_ACCOUNT' ||
          err.causeName === 'UNKNOWN_ACCESS_KEY')
      ) {
        return null;
      }
      throw err instanceof JsonRpcError
        ? unexpectedRpcError(SANDBOX_NEAR_TESTNET.testnetName, 'query', err)
        : err;
    }
  }

  /** The newest final block's hash: what a transaction is anchored to. */
  async finalBlockHash(): Promise<Uint8Array> {
    const block = await this.call<{ header?: { hash?: string } }>('block', {
      finality: 'final',
    });
    const hash = decodeBase58(block.header?.hash ?? '');
    if (!hash || hash.length !== 32) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `${SANDBOX_NEAR_TESTNET.testnetName} answered a block without a hash`,
      );
    }
    return hash;
  }

  /**
   * Broadcasts a signed transaction (base64) and waits until it is in a block,
   * which is when the node reports a transaction it refuses. A nonce already
   * used is not an error: the sandbox broadcasts the same bytes again after a
   * restart, and its own earlier inclusion is the likeliest reason; `tx` tells.
   */
  async sendTransaction(raw: string): Promise<NearBroadcast> {
    try {
      await this.rawCall<unknown>('send_tx', {
        signed_tx_base64: raw,
        wait_until: 'INCLUDED',
      });
      return 'accepted';
    } catch (err) {
      if (!(err instanceof JsonRpcError)) throw err;
      if (err.causeName === 'TIMEOUT_ERROR') return 'accepted';
      const invalid = invalidTxError(err);
      if (invalid === 'Expired') return 'expired';
      if (invalid === 'InvalidNonce') return 'accepted';
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `${SANDBOX_NEAR_TESTNET.testnetName} refused the transaction: ${
          invalid ?? err.message
        }`,
      );
    }
  }

  /** Where transaction `hash` of `sender` stands, without waiting for it. */
  async transaction(hash: string, sender: string): Promise<NearTxState> {
    let answer: {
      final_execution_status?: string;
      status?: unknown;
    };
    try {
      answer = await this.rawCall('tx', {
        tx_hash: hash,
        sender_account_id: sender,
        wait_until: 'NONE',
      });
    } catch (err) {
      if (
        err instanceof JsonRpcError &&
        err.causeName === 'UNKNOWN_TRANSACTION'
      ) {
        return { state: 'unknown' };
      }
      throw err instanceof JsonRpcError
        ? unexpectedRpcError(SANDBOX_NEAR_TESTNET.testnetName, 'tx', err)
        : err;
    }
    if (answer.final_execution_status !== SANDBOX_NEAR_FINAL_STATUS) {
      return { state: 'pending' };
    }
    const status = answer.status;
    if (status && typeof status === 'object' && 'SuccessValue' in status) {
      return { state: 'succeeded' };
    }
    if (status && typeof status === 'object' && 'Failure' in status) {
      return {
        state: 'failed',
        reason: JSON.stringify(status.Failure),
      };
    }
    return { state: 'pending' };
  }
}

/**
 * The `InvalidTxError` a node refused a transaction with: its variant name
 * (`Expired`, `InvalidNonce`, `NotEnoughBalance`, ...), or null for another
 * kind of error.
 */
function invalidTxError(err: JsonRpcError): string | null {
  if (err.causeName !== 'INVALID_TRANSACTION') return null;
  const data = err.data as
    { TxExecutionError?: { InvalidTxError?: unknown } } | undefined;
  const invalid = data?.TxExecutionError?.InvalidTxError;
  if (typeof invalid === 'string') return invalid;
  if (invalid && typeof invalid === 'object') {
    return Object.keys(invalid)[0] ?? null;
  }
  return 'InvalidTransaction';
}
