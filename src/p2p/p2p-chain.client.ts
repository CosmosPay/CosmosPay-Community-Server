import { Injectable } from '@nestjs/common';
import {
  callJsonRpc,
  JsonRpcError,
  type JsonRpcTarget,
  unexpectedRpcError,
} from '@/chains/json-rpc';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { EvmLog } from '@/evm/evm-rpc.client';
import { p2pRevertName } from '@/p2p/p2p-market-abi';
import {
  P2pNetworksService,
  type P2pDeployment,
} from '@/p2p/p2p-networks.service';

/** A mined transaction, as the matcher follower reads it. */
export interface P2pReceipt {
  succeeded: boolean;
  blockNumber: bigint;
}

/**
 * Why a simulated call would revert: the contract's error name when the node
 * relays it (`InsufficientBalance`), else the node's message.
 */
export class P2pCallReverted extends Error {
  constructor(
    readonly reason: string,
    readonly contractError: string | null,
  ) {
    super(reason);
    this.name = 'P2pCallReverted';
  }
}

/**
 * JSON-RPC access to the EVM networks the P2P market runs on, per deployment
 * (network and tier). Like `EvmRpcClient` and the sandbox's client, it refuses
 * a node on the wrong chain: before the first call to a deployment it compares
 * `eth_chainId` with the id in `P2P_NETWORKS`, so a URL pointed at another
 * chain (mainnet for a test network, above all) is a 503 and never a matcher
 * transaction there.
 */
@Injectable()
export class P2pChainClient {
  private readonly chainChecks = new Map<string, Promise<void>>();

  constructor(private readonly networks: P2pNetworksService) {}

  private target(d: P2pDeployment): JsonRpcTarget {
    return {
      provider: d.name,
      url: d.rpcUrl,
      timeoutMs: this.networks.timeoutMs(),
    };
  }

  private assertChain(d: P2pDeployment): Promise<void> {
    const key = `${d.tier}:${d.network}`;
    const cached = this.chainChecks.get(key);
    if (cached) return cached;
    const check = callJsonRpc<string>(this.target(d), 'eth_chainId', []).then(
      (answered) => {
        if (Number(BigInt(answered)) !== d.chainId) {
          throw ApiError.misconfigured(
            `The P2P market cannot reach ${d.name} right now.`,
            `The P2P RPC for ${d.network} on ${d.tier} serves chain ${Number(BigInt(answered))}, ` +
              `not ${d.chainId}: check P2P_RPC_URLS_${d.tier === 'public' ? 'MAINNET' : 'TESTNET'}.`,
          );
        }
      },
    );
    this.chainChecks.set(key, check);
    check.catch(() => this.chainChecks.delete(key));
    return check;
  }

  /** One call, a JSON-RPC error left as a {@link JsonRpcError}. */
  private async rawCall<T>(
    d: P2pDeployment,
    method: string,
    params: unknown[],
  ): Promise<T> {
    await this.assertChain(d);
    return callJsonRpc<T>(this.target(d), method, params);
  }

  /** One call, any JSON-RPC error answered as a 502. */
  private async call<T>(
    d: P2pDeployment,
    method: string,
    params: unknown[],
  ): Promise<T> {
    try {
      return await this.rawCall<T>(d, method, params);
    } catch (err) {
      throw err instanceof JsonRpcError
        ? unexpectedRpcError(d.name, method, err)
        : err;
    }
  }

  async blockNumber(d: P2pDeployment): Promise<bigint> {
    return BigInt(await this.call<string>(d, 'eth_blockNumber', []));
  }

  /** Unix seconds of a block, or null when the node does not have it. */
  async blockTimestamp(
    d: P2pDeployment,
    block: bigint,
  ): Promise<number | null> {
    const answer = await this.call<{ timestamp: string } | null>(
      d,
      'eth_getBlockByNumber',
      [`0x${block.toString(16)}`, false],
    );
    return answer ? Number(BigInt(answer.timestamp)) : null;
  }

  /** The contract's logs in `[from, to]` whose topic0 is one of `topics`. */
  getLogs(
    d: P2pDeployment,
    topics: readonly string[],
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<EvmLog[]> {
    return this.call<EvmLog[]>(d, 'eth_getLogs', [
      {
        address: d.contract,
        topics: [topics],
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
      },
    ]);
  }

  /** A read-only call; without `to`, `data` runs as init code. */
  ethCall(
    d: P2pDeployment,
    call: { to?: string; data: string },
  ): Promise<string> {
    return this.call<string>(d, 'eth_call', [call, 'latest']);
  }

  getCode(d: P2pDeployment, address: string): Promise<string> {
    return this.call<string>(d, 'eth_getCode', [address, 'latest']);
  }

  /** The next nonce of `address`, counting transactions still in the pool. */
  async pendingNonce(d: P2pDeployment, address: string): Promise<bigint> {
    return BigInt(
      await this.call<string>(d, 'eth_getTransactionCount', [
        address,
        'pending',
      ]),
    );
  }

  /** How many transactions of `address` are mined: a nonce below it is spent for good. */
  async minedNonce(d: P2pDeployment, address: string): Promise<bigint> {
    return BigInt(
      await this.call<string>(d, 'eth_getTransactionCount', [
        address,
        'latest',
      ]),
    );
  }

  /**
   * Gas for a call. A call the contract would revert is a
   * {@link P2pCallReverted} naming the contract's error, so the caller can
   * refuse the request BEFORE anything is signed.
   */
  async estimateGas(
    d: P2pDeployment,
    tx: { from: string; to: string; data: string },
  ): Promise<bigint> {
    try {
      return BigInt(await this.rawCall<string>(d, 'eth_estimateGas', [tx]));
    } catch (err) {
      if (err instanceof JsonRpcError) {
        const name = p2pRevertName(err.data);
        throw new P2pCallReverted(name ?? err.message, name);
      }
      throw err;
    }
  }

  /** What to bid: EIP-1559 caps, from the node's gas price and tip. */
  async feeData(
    d: P2pDeployment,
  ): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const gasPrice = BigInt(await this.call<string>(d, 'eth_gasPrice', []));
    let tip: bigint;
    try {
      tip = BigInt(
        await this.rawCall<string>(d, 'eth_maxPriorityFeePerGas', []),
      );
    } catch (err) {
      if (!(err instanceof JsonRpcError)) throw err;
      tip = gasPrice;
    }
    const priority = tip > gasPrice ? gasPrice : tip;
    return {
      maxFeePerGas: gasPrice * 2n + priority,
      maxPriorityFeePerGas: priority,
    };
  }

  /**
   * Broadcasts signed bytes. A node that already holds them ("already known",
   * "nonce too low" for one that was mined) is not an error: the follower sends
   * the same stored bytes again until they are mined.
   */
  async sendRawTransaction(d: P2pDeployment, raw: string): Promise<void> {
    try {
      await this.rawCall<string>(d, 'eth_sendRawTransaction', [raw]);
    } catch (err) {
      if (
        err instanceof JsonRpcError &&
        /already known|known transaction|nonce too low|already imported/i.test(
          err.message,
        )
      ) {
        return;
      }
      throw err instanceof JsonRpcError
        ? ApiError.badGateway(
            ApiErrorCode.ProviderError,
            `${d.name} refused the transaction: ${err.message}`,
          )
        : err;
    }
  }

  /** A transaction's receipt; null while it is not mined. */
  async receipt(d: P2pDeployment, hash: string): Promise<P2pReceipt | null> {
    const answer = await this.call<{
      status?: string;
      blockNumber?: string;
    } | null>(d, 'eth_getTransactionReceipt', [hash]);
    if (!answer?.blockNumber) return null;
    return {
      succeeded: answer.status === '0x1',
      blockNumber: BigInt(answer.blockNumber),
    };
  }
}
