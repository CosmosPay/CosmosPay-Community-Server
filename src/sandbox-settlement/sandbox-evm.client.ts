import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  callJsonRpc,
  JsonRpcError,
  type JsonRpcTarget,
  unexpectedRpcError,
} from '@/chains/json-rpc';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig } from '@/config/configuration';
import { ERC20_TRANSFER_SELECTOR } from '@/evm/evm.constants';
import type { PaymentNetwork } from '@/payment-intents/payment-networks';
import {
  SANDBOX_NETWORKS,
  type SandboxEvmNetwork,
} from '@/sandbox-settlement/sandbox-settlement.constants';

/** `balanceOf(address)`. */
const BALANCE_OF_SELECTOR = '0x70a08231';

/** A mined transaction's outcome, as the sandbox reads it. */
export interface SandboxReceipt {
  /** True when the transaction succeeded (`status` 0x1). */
  succeeded: boolean;
  blockNumber: bigint;
}

/** `transfer(to, amount)` calldata. */
export function erc20TransferCalldata(to: string, amount: bigint): string {
  return (
    ERC20_TRANSFER_SELECTOR +
    to.toLowerCase().replace(/^0x/, '').padStart(64, '0') +
    amount.toString(16).padStart(64, '0')
  );
}

/**
 * JSON-RPC access to the sandbox's EVM TEST networks. Like `EvmRpcClient`, it
 * refuses a node on the wrong chain: before the first call to a network it
 * compares `eth_chainId` with the test network's EIP-155 id in
 * `SANDBOX_NETWORKS`, so a URL pointed at a mainnet (or at another test network)
 * is a 503, never a payout there.
 */
@Injectable()
export class SandboxEvmClient {
  private readonly chainChecks = new Map<string, Promise<void>>();

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /** The network's sandbox entry; throws for one the sandbox does not settle on. */
  network(id: PaymentNetwork): SandboxEvmNetwork {
    const entry = SANDBOX_NETWORKS[id];
    if (entry.kind !== 'evm') {
      throw new Error(`Sandbox network ${id} is not an EVM test network`);
    }
    return entry;
  }

  private target(id: PaymentNetwork): JsonRpcTarget {
    const settings = this.config.get('sandbox', { infer: true });
    const entry = this.network(id);
    return {
      provider: entry.testnetName,
      url: settings.rpcUrls[id] ?? entry.defaultRpcUrl,
      timeoutMs: settings.timeoutMs,
    };
  }

  private assertChain(id: PaymentNetwork): Promise<void> {
    const cached = this.chainChecks.get(id);
    if (cached) return cached;
    const expected = this.network(id).chainId;
    const check = callJsonRpc<string>(this.target(id), 'eth_chainId', []).then(
      (answered) => {
        if (Number(BigInt(answered)) !== expected) {
          throw ApiError.misconfigured(
            'The sandbox cannot reach this test network right now.',
            `The sandbox RPC for ${id} serves chain ${Number(BigInt(answered))}, ` +
              `not ${expected}: check SANDBOX_RPC_URLS.`,
          );
        }
      },
    );
    this.chainChecks.set(id, check);
    check.catch(() => this.chainChecks.delete(id));
    return check;
  }

  /** One call, a JSON-RPC error left as a {@link JsonRpcError}. */
  private async rawCall<T>(
    id: PaymentNetwork,
    method: string,
    params: unknown[],
  ): Promise<T> {
    await this.assertChain(id);
    return callJsonRpc<T>(this.target(id), method, params);
  }

  /** One call, any JSON-RPC error answered as a 502. */
  private async call<T>(
    id: PaymentNetwork,
    method: string,
    params: unknown[],
  ): Promise<T> {
    try {
      return await this.rawCall<T>(id, method, params);
    } catch (err) {
      throw err instanceof JsonRpcError
        ? unexpectedRpcError(this.network(id).testnetName, method, err)
        : err;
    }
  }

  /** An ERC-20 balance, in base units. A token that does not answer reads 0. */
  async erc20BalanceOf(
    id: PaymentNetwork,
    token: string,
    owner: string,
  ): Promise<bigint> {
    const data =
      BALANCE_OF_SELECTOR +
      owner.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    let answer: string;
    try {
      answer = await this.rawCall<string>(id, 'eth_call', [
        { to: token, data },
        'latest',
      ]);
    } catch (err) {
      if (err instanceof JsonRpcError) return 0n;
      throw err;
    }
    return /^0x[0-9a-fA-F]{64}$/.test(answer) ? BigInt(answer) : 0n;
  }

  /** The native coin balance (gas), in wei. */
  async nativeBalance(id: PaymentNetwork, owner: string): Promise<bigint> {
    return BigInt(
      await this.call<string>(id, 'eth_getBalance', [owner, 'latest']),
    );
  }

  /** `eth_call` returning raw hex. */
  ethCall(
    id: PaymentNetwork,
    call: { to: string; data: string },
  ): Promise<string> {
    return this.call<string>(id, 'eth_call', [call, 'latest']);
  }

  /** The next nonce of `address`, counting transactions still in the pool. */
  async pendingNonce(id: PaymentNetwork, address: string): Promise<bigint> {
    return BigInt(
      await this.call<string>(id, 'eth_getTransactionCount', [
        address,
        'pending',
      ]),
    );
  }

  /** Gas for a call; null when the node cannot estimate it. */
  async estimateGas(
    id: PaymentNetwork,
    tx: { from: string; to: string; data: string },
  ): Promise<bigint | null> {
    try {
      return BigInt(await this.rawCall<string>(id, 'eth_estimateGas', [tx]));
    } catch (err) {
      if (err instanceof JsonRpcError) return null;
      throw err;
    }
  }

  /**
   * What to bid: EIP-1559 when the node suggests a tip, otherwise the legacy
   * gas price as both caps (a test network without `eth_maxPriorityFeePerGas`).
   */
  async feeData(
    id: PaymentNetwork,
  ): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const gasPrice = BigInt(await this.call<string>(id, 'eth_gasPrice', []));
    let tip: bigint;
    try {
      tip = BigInt(
        await this.rawCall<string>(id, 'eth_maxPriorityFeePerGas', []),
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
   * Broadcasts a signed transaction. A node that already holds it ("already
   * known", "nonce too low" for one that was mined) is not an error: the
   * sandbox rebroadcasts the same signed bytes after a restart, and the hash is
   * what it follows.
   */
  async sendRawTransaction(id: PaymentNetwork, raw: string): Promise<void> {
    try {
      await this.rawCall<string>(id, 'eth_sendRawTransaction', [raw]);
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
            `${this.network(id).testnetName} refused the transaction: ${err.message}`,
          )
        : err;
    }
  }

  /** A transaction's receipt; null while it is not mined. */
  async receipt(
    id: PaymentNetwork,
    hash: string,
  ): Promise<SandboxReceipt | null> {
    const answer = await this.call<{
      status?: string;
      blockNumber?: string;
    } | null>(id, 'eth_getTransactionReceipt', [hash]);
    if (!answer || !answer.blockNumber) return null;
    return {
      succeeded: answer.status === '0x1',
      blockNumber: BigInt(answer.blockNumber),
    };
  }
}
