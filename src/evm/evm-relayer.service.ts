import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { EvmRpcClient } from '@/evm/evm-rpc.client';
import { addressOfSecretKey, signEip1559 } from '@/evm/evm-transaction';
import {
  EVM_MIN_MAX_FEE_PER_GAS,
  type EvmChain,
  RELAYER_GAS_LIMIT_MARGIN_BPS,
} from '@/evm/evm.constants';
import { hexToBytes } from '@/evm/rlp';

/**
 * The one key per EVM chain this service signs transactions with: the relayer
 * that deploys deposit forwarders (`MONAD_RELAYER_PRIVATE_KEY`,
 * `ARC_RELAYER_PRIVATE_KEY`).
 *
 * It holds gas money and nothing else. The only transactions it sends are the
 * forwarders' deployments and `flush` calls, and a forwarder can pay nobody but
 * the merchant baked into its address (and this relayer its one-time fee), so
 * whoever steals the key can burn its gas and collect nothing else. Keep it
 * funded modestly, and alert on its balance rather than overfunding it.
 *
 * Sends are serialized in-process: two in flight would read the same pending
 * nonce. Across replicas the deposit forwarder's advisory lock guarantees only
 * one process sends at a time.
 */
@Injectable()
export class EvmRelayer {
  private readonly secretKeys = new Map<EvmChain, Uint8Array>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly rpc: EvmRpcClient,
  ) {}

  /** Whether deposit addresses are on: a relayer key is configured. */
  isEnabled(chain: EvmChain): boolean {
    return this.config.get(chain, { infer: true }).relayerPrivateKey !== '';
  }

  private key(chain: EvmChain): Uint8Array {
    const cached = this.secretKeys.get(chain);
    if (cached) return cached;
    const hex = this.config.get(chain, { infer: true }).relayerPrivateKey;
    if (!hex) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        `No relayer key is configured (${chain.toUpperCase()}_RELAYER_PRIVATE_KEY).`,
      );
    }
    const key = hexToBytes(hex.startsWith('0x') ? hex : `0x${hex}`);
    this.secretKeys.set(chain, key);
    return key;
  }

  /** The relayer's address, EIP-55 — baked into every forwarder as its fee payee. */
  address(chain: EvmChain): string {
    return addressOfSecretKey(this.key(chain));
  }

  /**
   * Signs and broadcasts a zero-value call, with a gas limit a little over the
   * estimate (Monad bills the whole limit, so a generous one is money lost on
   * every forward) and a fee cap never under the chain's mempool floor (Arc
   * drops anything under 20 gwei without a word). Answers the transaction hash.
   */
  send(
    chain: EvmChain,
    network: StellarNetwork,
    call: { to: string; data: string },
  ): Promise<string> {
    const run = async () => {
      const from = this.address(chain);
      const [nonce, fees, estimate] = await Promise.all([
        this.rpc.pendingNonce(chain, network, from),
        this.rpc.feeData(chain, network),
        this.rpc.estimateGas(chain, network, { from, ...call }),
      ]);
      const floor = EVM_MIN_MAX_FEE_PER_GAS[chain];
      const maxFeePerGas =
        fees.maxFeePerGas < floor ? floor : fees.maxFeePerGas;
      const signed = signEip1559(
        {
          chainId: this.rpc.chainId(chain, network),
          nonce,
          maxFeePerGas,
          maxPriorityFeePerGas:
            fees.maxPriorityFeePerGas > maxFeePerGas
              ? maxFeePerGas
              : fees.maxPriorityFeePerGas,
          gasLimit: (estimate * RELAYER_GAS_LIMIT_MARGIN_BPS) / 10_000n,
          to: call.to,
          value: 0n,
          data: call.data,
        },
        this.key(chain),
      );
      await this.rpc.sendRawTransaction(chain, network, signed.raw);
      return signed.hash;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
