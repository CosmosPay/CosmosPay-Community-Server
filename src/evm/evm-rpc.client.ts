import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  callJsonRpc,
  JsonRpcError,
  type JsonRpcTarget,
  unexpectedRpcError,
} from '@/chains/json-rpc';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import {
  ERC20_DECIMALS_SELECTOR,
  EVM_CHAIN_IDS,
  EVM_PROVIDER_NAMES,
  type EvmChain,
} from '@/evm/evm.constants';

/** The parts of `eth_getTransactionByHash` this service reads. */
export interface EvmTransaction {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  input: string;
  blockNumber: string | null;
}

/** The parts of `eth_getTransactionReceipt` this service reads. */
export interface EvmReceipt {
  transactionHash: string;
  from: string;
  to: string | null;
  /** `0x1` success, `0x0` reverted. */
  status: string;
  blockNumber: string;
  logs: EvmLog[];
}

export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

export interface EvmLogFilter {
  address: string;
  topics: (string | null)[];
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * JSON-RPC access to the EVM chains this service speaks (Monad), per network
 * tier. Like the Solana client it refuses a node on the wrong chain: before
 * the first read of a tier it compares `eth_chainId` with the chain's EIP-155
 * id, because that id is written into every payment link and a link that
 * settles on another chain is a payment nobody will ever see.
 */
@Injectable()
export class EvmRpcClient {
  private readonly chainChecks = new Map<string, Promise<void>>();

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /** The chain's EIP-155 id on a tier. */
  chainId(chain: EvmChain, network: StellarNetwork): number {
    return EVM_CHAIN_IDS[chain][network];
  }

  private target(chain: EvmChain, network: StellarNetwork): JsonRpcTarget {
    const settings = this.config.get(chain, { infer: true });
    return {
      provider: EVM_PROVIDER_NAMES[chain],
      url: settings.rpcUrls[network],
      timeoutMs: settings.timeoutMs,
    };
  }

  /** Blocks one `eth_getLogs` may span on this chain's configured node. */
  logBlockRange(chain: EvmChain): number {
    return this.config.get(chain, { infer: true }).logBlockRange;
  }

  /** One call, a JSON-RPC error left as a {@link JsonRpcError}. */
  private async rawCall<T>(
    chain: EvmChain,
    network: StellarNetwork,
    method: string,
    params: unknown[],
  ): Promise<T> {
    await this.assertChain(chain, network);
    return callJsonRpc<T>(this.target(chain, network), method, params);
  }

  /** One call, any JSON-RPC error answered as the 502 a route reports. */
  private async call<T>(
    chain: EvmChain,
    network: StellarNetwork,
    method: string,
    params: unknown[],
  ): Promise<T> {
    try {
      return await this.rawCall<T>(chain, network, method, params);
    } catch (err) {
      throw err instanceof JsonRpcError
        ? unexpectedRpcError(EVM_PROVIDER_NAMES[chain], method, err)
        : err;
    }
  }

  private assertChain(chain: EvmChain, network: StellarNetwork): Promise<void> {
    const key = `${chain}:${network}`;
    const cached = this.chainChecks.get(key);
    if (cached) return cached;
    const expected = this.chainId(chain, network);
    const check = callJsonRpc<string>(
      this.target(chain, network),
      'eth_chainId',
      [],
    ).then((answered) => {
      if (Number(BigInt(answered)) !== expected) {
        throw ApiError.unavailable(
          ApiErrorCode.Misconfigured,
          `The ${EVM_PROVIDER_NAMES[chain]} RPC configured for the ${network} ` +
            `tier serves chain ${Number(BigInt(answered))}, not ${expected}. ` +
            `Check ${chain.toUpperCase()}_RPC_URL_${network === 'public' ? 'MAINNET' : 'TESTNET'}.`,
        );
      }
    });
    this.chainChecks.set(key, check);
    check.catch(() => this.chainChecks.delete(key));
    return check;
  }

  async blockNumber(chain: EvmChain, network: StellarNetwork): Promise<bigint> {
    return BigInt(
      await this.call<string>(chain, network, 'eth_blockNumber', []),
    );
  }

  /** Unix seconds of a block. */
  async blockTimestamp(
    chain: EvmChain,
    network: StellarNetwork,
    blockNumber: string,
  ): Promise<number | null> {
    const block = await this.call<{ timestamp: string } | null>(
      chain,
      network,
      'eth_getBlockByNumber',
      [blockNumber, false],
    );
    return block ? Number(BigInt(block.timestamp)) : null;
  }

  getTransaction(
    chain: EvmChain,
    network: StellarNetwork,
    hash: string,
  ): Promise<EvmTransaction | null> {
    return this.call(chain, network, 'eth_getTransactionByHash', [hash]);
  }

  getReceipt(
    chain: EvmChain,
    network: StellarNetwork,
    hash: string,
  ): Promise<EvmReceipt | null> {
    return this.call(chain, network, 'eth_getTransactionReceipt', [hash]);
  }

  getLogs(
    chain: EvmChain,
    network: StellarNetwork,
    filter: EvmLogFilter,
  ): Promise<EvmLog[]> {
    return this.call(chain, network, 'eth_getLogs', [
      {
        address: filter.address,
        topics: filter.topics,
        fromBlock: `0x${filter.fromBlock.toString(16)}`,
        toBlock: `0x${filter.toBlock.toString(16)}`,
      },
    ]);
  }

  /**
   * An ERC-20's `decimals()`, or null when `token` does not answer it — an
   * account with no code, or a contract that is not a token.
   */
  async erc20Decimals(
    chain: EvmChain,
    network: StellarNetwork,
    token: string,
  ): Promise<number | null> {
    let answer: string;
    try {
      answer = await this.rawCall<string>(chain, network, 'eth_call', [
        { to: token, data: ERC20_DECIMALS_SELECTOR },
        'latest',
      ]);
    } catch (err) {
      // A revert is an answer about the contract, not about the node.
      if (err instanceof JsonRpcError) return null;
      throw err;
    }
    // No code at the address answers `0x`; a token answers one 32-byte word.
    if (!/^0x[0-9a-fA-F]{64}$/.test(answer)) return null;
    const decimals = BigInt(answer);
    return decimals <= 255n ? Number(decimals) : null;
  }
}
