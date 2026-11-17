import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CHAIN_RPC_MAX_RESPONSE_BYTES } from '@/chains/chains.constants';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig } from '@/config/configuration';
import { hexToBytes } from '@/evm/rlp';
import type { PaymentNetwork } from '@/payment-intents/payment-networks';
import { APTOS_FA_METADATA_TYPE } from '@/sandbox-settlement/sandbox-aptos.constants';
import type { SandboxAptosNetwork } from '@/sandbox-settlement/sandbox-aptos.constants';
import { SANDBOX_NETWORKS } from '@/sandbox-settlement/sandbox-settlement.constants';

/** A transaction as the REST API answers it by hash. */
export type AptosTransactionState =
  | { state: 'pending' }
  | { state: 'committed'; success: boolean; vmStatus: string; hash: string };

/** One answer of the REST API: its status and its JSON body. */
interface RestAnswer<T> {
  status: number;
  body: T;
}

/** The fungible-asset struct the balance view is generic over. */
const METADATA_TYPE = `${APTOS_FA_METADATA_TYPE.address}::${APTOS_FA_METADATA_TYPE.module}::${APTOS_FA_METADATA_TYPE.name}`;

/**
 * The Aptos test network's REST API, as the sandbox reads and writes it.
 * Like `SandboxEvmClient`, it refuses a node on another network: before the
 * first call it compares `GET /v1`'s `chain_id` with the one in
 * `SANDBOX_NETWORKS`, so a URL pointed at mainnet is a 503, never a payout
 * there. Transport failures are the upstream errors the contract documents
 * (503 unreachable or throttled, 504 timed out, 502 an unreadable body); a
 * 404 for an account or a transaction is an answer, not a fault.
 */
@Injectable()
export class SandboxAptosClient {
  private readonly chainChecks = new Map<string, Promise<void>>();

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /** The network's sandbox entry; throws for one that is not Aptos. */
  network(id: PaymentNetwork): SandboxAptosNetwork {
    const entry = SANDBOX_NETWORKS[id];
    if (entry.kind !== 'aptos') {
      throw new Error(`Sandbox network ${id} is not an Aptos test network`);
    }
    return entry;
  }

  private baseUrl(id: PaymentNetwork): string {
    const settings = this.config.get('sandbox', { infer: true });
    return (settings.rpcUrls[id] ?? this.network(id).defaultRpcUrl).replace(
      /\/+$/,
      '',
    );
  }

  /** One HTTP call; any status comes back, transport failures are thrown. */
  private async fetchJson<T>(
    id: PaymentNetwork,
    path: string,
    init: { method?: string; body?: string | Uint8Array; type?: string } = {},
  ): Promise<RestAnswer<T>> {
    const provider = `${this.network(id).testnetName} API`;
    const { timeoutMs } = this.config.get('sandbox', { infer: true });
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl(id)}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(init.type ? { 'content-type': init.type } : {}),
        },
        body: init.body as BodyInit | undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new ApiError(
          HttpStatus.GATEWAY_TIMEOUT,
          ApiErrorCode.ProviderUnavailable,
          `${provider} did not answer in time`,
        );
      }
      throw ApiError.unavailable(
        ApiErrorCode.ProviderUnavailable,
        `${provider} is unreachable`,
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw ApiError.unavailable(
        ApiErrorCode.ProviderUnavailable,
        `${provider} is unavailable (HTTP ${response.status})`,
      );
    }
    const text = await response.text();
    if (text.length > CHAIN_RPC_MAX_RESPONSE_BYTES) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `${provider} answered with an oversized body`,
      );
    }
    try {
      return { status: response.status, body: JSON.parse(text) as T };
    } catch {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `${provider} answered with a body that is not JSON`,
      );
    }
  }

  private assertChain(id: PaymentNetwork): Promise<void> {
    const cached = this.chainChecks.get(id);
    if (cached) return cached;
    const expected = this.network(id).chainId;
    const check = this.fetchJson<{ chain_id?: number }>(id, '/').then(
      ({ status, body }) => {
        if (status !== 200 || body.chain_id !== expected) {
          throw ApiError.misconfigured(
            'The sandbox cannot reach this test network right now.',
            `The sandbox node for ${id} serves chain ${String(body.chain_id)}, ` +
              `not ${expected}: check SANDBOX_RPC_URLS.`,
          );
        }
      },
    );
    this.chainChecks.set(id, check);
    check.catch(() => this.chainChecks.delete(id));
    return check;
  }

  /** A checked call: the node's chain first, then `path`. */
  private async call<T>(
    id: PaymentNetwork,
    path: string,
    init?: { method?: string; body?: string | Uint8Array; type?: string },
  ): Promise<RestAnswer<T>> {
    await this.assertChain(id);
    return this.fetchJson<T>(id, path, init);
  }

  /** An answer that should have been 200, else a 502 naming what it said. */
  private ok<T>(id: PaymentNetwork, what: string, answer: RestAnswer<T>): T {
    if (answer.status === 200) return answer.body;
    const message = (answer.body as { message?: unknown }).message;
    throw ApiError.badGateway(
      ApiErrorCode.ProviderError,
      `${this.network(id).testnetName} refused ${what} (HTTP ${answer.status}` +
        `${typeof message === 'string' ? `: ${message.slice(0, 200)}` : ''})`,
    );
  }

  /** The account's next sequence number; null when it does not exist on-chain. */
  async sequenceNumber(
    id: PaymentNetwork,
    address: string,
  ): Promise<bigint | null> {
    const answer = await this.call<{ sequence_number?: string }>(
      id,
      `/accounts/${address}`,
    );
    if (answer.status === 404) return null;
    return BigInt(this.ok(id, 'the account read', answer).sequence_number ?? 0);
  }

  /** A view function's answer. */
  private async view(
    id: PaymentNetwork,
    fn: string,
    typeArguments: string[],
    args: string[],
  ): Promise<unknown[]> {
    const answer = await this.call<unknown[]>(id, '/view', {
      method: 'POST',
      type: 'application/json',
      body: JSON.stringify({
        function: fn,
        type_arguments: typeArguments,
        arguments: args,
      }),
    });
    return this.ok(id, `the view ${fn}`, answer);
  }

  /**
   * What `owner`'s primary store holds of the fungible asset `metadata`, in
   * base units; 0 when it has no store yet (the view answers 0 then).
   */
  async faBalance(
    id: PaymentNetwork,
    owner: string,
    metadata: string,
  ): Promise<bigint> {
    const [balance] = await this.view(
      id,
      '0x1::primary_fungible_store::balance',
      [METADATA_TYPE],
      [owner, metadata],
    );
    return BigInt(String(balance));
  }

  /** The APT `owner` can pay gas with, in octas (coin and fungible store together). */
  async aptBalance(id: PaymentNetwork, owner: string): Promise<bigint> {
    const [balance] = await this.view(
      id,
      '0x1::coin::balance',
      ['0x1::aptos_coin::AptosCoin'],
      [owner],
    );
    return BigInt(String(balance));
  }

  /** The node's gas unit price estimate, in octas. */
  async gasUnitPrice(id: PaymentNetwork): Promise<bigint> {
    const body = this.ok(
      id,
      'the gas estimate',
      await this.call<{ gas_estimate?: number }>(id, '/estimate_gas_price'),
    );
    return BigInt(body.gas_estimate ?? 0);
  }

  /**
   * Submits signed BCS bytes. A node that already holds them (in its mempool,
   * or committed, which reads "sequence number too old") is not an error: the
   * sandbox submits the same bytes again until they are final, and the hash is
   * what it follows.
   */
  async submit(id: PaymentNetwork, raw: string): Promise<void> {
    const answer = await this.call<{ message?: string }>(id, '/transactions', {
      method: 'POST',
      type: 'application/x.aptos.signed_transaction+bcs',
      body: hexToBytes(raw),
    });
    if (answer.status === 200 || answer.status === 202) return;
    const message = answer.body.message ?? '';
    if (/already|SEQUENCE_NUMBER_TOO_OLD/i.test(message)) return;
    throw ApiError.badGateway(
      ApiErrorCode.ProviderError,
      `${this.network(id).testnetName} refused the transaction: ${message.slice(0, 200)}`,
    );
  }

  /** A transaction by hash: pending, committed, or null when the node knows none. */
  async transactionByHash(
    id: PaymentNetwork,
    hash: string,
  ): Promise<AptosTransactionState | null> {
    const answer = await this.call<{
      type?: string;
      success?: boolean;
      vm_status?: string;
      hash?: string;
    }>(id, `/transactions/by_hash/${hash}`);
    if (answer.status === 404) return null;
    return this.state(this.ok(id, 'the transaction read', answer));
  }

  /**
   * The committed transaction of `address` with `sequenceNumber`; null when
   * none is listed there (not committed yet, or pruned from this node).
   */
  async accountTransactionAt(
    id: PaymentNetwork,
    address: string,
    sequenceNumber: bigint,
  ): Promise<AptosTransactionState | null> {
    const answer = await this.call<
      { type?: string; success?: boolean; vm_status?: string; hash?: string }[]
    >(id, `/accounts/${address}/transactions?start=${sequenceNumber}&limit=1`);
    if (answer.status === 404) return null;
    const [tx] = this.ok(id, 'the account transactions read', answer);
    return tx ? this.state(tx) : null;
  }

  private state(tx: {
    type?: string;
    success?: boolean;
    vm_status?: string;
    hash?: string;
  }): AptosTransactionState {
    if (tx.type === 'pending_transaction') return { state: 'pending' };
    return {
      state: 'committed',
      success: tx.success === true,
      vmStatus: tx.vm_status ?? '',
      hash: (tx.hash ?? '').toLowerCase(),
    };
  }
}
