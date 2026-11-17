import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CHAIN_RPC_MAX_RESPONSE_BYTES } from '@/chains/chains.constants';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig } from '@/config/configuration';
import type { SuiObjectRef } from '@/sandbox-settlement/sandbox-sui.codec';
import {
  SUI_MAX_COINS_PER_TRANSFER,
  SUI_TESTNET,
} from '@/sandbox-settlement/sandbox-sui.constants';

/** The node answered with GraphQL errors (it read the request and said no). */
export class SuiGraphqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuiGraphqlError';
  }
}

/** A coin object and what it holds. */
export interface SuiCoin {
  ref: SuiObjectRef;
  balance: bigint;
}

/** One coin type held by an address: as coin objects, in its address balance, and both. */
export interface SuiBalance {
  total: bigint;
  coins: bigint;
  addressBalance: bigint;
}

/** An executed transaction's outcome. */
export type SuiExecutionStatus = 'SUCCESS' | 'FAILURE';

const NETWORK_ID = 'sui';

/**
 * Sui testnet through its GraphQL service (public fullnodes no longer serve
 * JSON-RPC). Like `SandboxEvmClient`, it refuses a node on the wrong network:
 * before the first call it compares `chainIdentifier` (the genesis checkpoint
 * digest) with `SUI_TESTNET`'s, so a URL pointed at mainnet is a 503, never a
 * payout there. Every value goes in as a GraphQL variable, never spliced into
 * the query text.
 */
@Injectable()
export class SandboxSuiClient {
  private chainCheck: Promise<void> | null = null;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private url(): string {
    return (
      this.config.get('sandbox', { infer: true }).rpcUrls[NETWORK_ID] ??
      SUI_TESTNET.defaultRpcUrl
    );
  }

  /**
   * One GraphQL request. Transport failures are the upstream errors routes
   * document (503 unreachable or throttled, 504 timed out, 502 a body that is
   * not a GraphQL answer); GraphQL `errors` are a {@link SuiGraphqlError} for
   * the caller to read.
   */
  private async post<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const provider = SUI_TESTNET.testnetName;
    const timeoutMs = this.config.get('sandbox', { infer: true }).timeoutMs;
    let response: Response;
    try {
      response = await fetch(this.url(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
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
    let body: { data?: T | null; errors?: { message?: string }[] };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `${provider} answered with a body that is not JSON`,
      );
    }
    if (body.errors?.length) {
      throw new SuiGraphqlError(
        body.errors.map((e) => e.message ?? 'GraphQL error').join('; '),
      );
    }
    if (!response.ok || !body.data) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `${provider} answered without data (HTTP ${response.status})`,
      );
    }
    return body.data;
  }

  private assertChain(): Promise<void> {
    if (this.chainCheck) return this.chainCheck;
    const check = this.post<{ chainIdentifier: string }>(
      '{ chainIdentifier }',
      {},
    ).then(({ chainIdentifier }) => {
      if (chainIdentifier !== SUI_TESTNET.chainIdentifier) {
        throw ApiError.misconfigured(
          'The sandbox cannot reach this test network right now.',
          `The sandbox node for sui serves chain ${chainIdentifier}, ` +
            `not ${SUI_TESTNET.chainIdentifier}: check SANDBOX_RPC_URLS.`,
        );
      }
    });
    this.chainCheck = check;
    check.catch(() => {
      this.chainCheck = null;
    });
    return check;
  }

  /** A query on the checked network; GraphQL errors answered as a 502. */
  private async query<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    await this.assertChain();
    try {
      return await this.post<T>(query, variables);
    } catch (err) {
      throw err instanceof SuiGraphqlError
        ? ApiError.badGateway(
            ApiErrorCode.ProviderError,
            `${SUI_TESTNET.testnetName} refused the query: ${err.message}`,
          )
        : err;
    }
  }

  /** What `owner` holds of `coinType`, in base units. */
  async balance(owner: string, coinType: string): Promise<SuiBalance> {
    const data = await this.query<{
      address: {
        balance: {
          totalBalance: string | null;
          coinBalance: string | null;
          addressBalance: string | null;
        } | null;
      } | null;
    }>(
      `query ($owner: SuiAddress!, $type: String!) {
        address(address: $owner) {
          balance(coinType: $type) { totalBalance coinBalance addressBalance }
        }
      }`,
      { owner, type: coinType },
    );
    const balance = data.address?.balance;
    return {
      total: BigInt(balance?.totalBalance ?? '0'),
      coins: BigInt(balance?.coinBalance ?? '0'),
      addressBalance: BigInt(balance?.addressBalance ?? '0'),
    };
  }

  /**
   * `owner`'s coin objects of `coinType` (the first
   * {@link SUI_MAX_COINS_PER_TRANSFER}), largest first.
   */
  async coins(owner: string, coinType: string): Promise<SuiCoin[]> {
    const data = await this.query<{
      address: {
        objects: {
          nodes: {
            address: string;
            version: number | string;
            digest: string;
            contents: { json: { balance?: string } | null } | null;
          }[];
        } | null;
      } | null;
    }>(
      `query ($owner: SuiAddress!, $type: String!, $first: Int!) {
        address(address: $owner) {
          objects(first: $first, filter: { type: $type }) {
            nodes { address version digest contents { json } }
          }
        }
      }`,
      {
        owner,
        type: `0x2::coin::Coin<${coinType}>`,
        first: SUI_MAX_COINS_PER_TRANSFER,
      },
    );
    return (data.address?.objects?.nodes ?? [])
      .map((node) => ({
        ref: {
          objectId: node.address,
          version: BigInt(node.version),
          digest: node.digest,
        },
        balance: BigInt(node.contents?.json?.balance ?? '0'),
      }))
      .sort((a, b) =>
        a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1,
      );
  }

  /** The current epoch's reference gas price, in MIST. */
  async referenceGasPrice(): Promise<bigint> {
    const data = await this.query<{
      epoch: { referenceGasPrice: string | null } | null;
    }>('{ epoch { referenceGasPrice } }', {});
    const price = data.epoch?.referenceGasPrice;
    if (!price) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `${SUI_TESTNET.testnetName} answered no reference gas price`,
      );
    }
    return BigInt(price);
  }

  /** An executed transaction's status; null while the node does not know it. */
  async transactionStatus(digest: string): Promise<SuiExecutionStatus | null> {
    const data = await this.query<{
      transaction: { effects: { status: SuiExecutionStatus } | null } | null;
    }>(
      `query ($digest: String!) {
        transaction(digest: $digest) { effects { status } }
      }`,
      { digest },
    );
    return data.transaction?.effects?.status ?? null;
  }

  /**
   * Executes a signed transaction and answers its outcome. Executing one that
   * already ran answers its effects again (validators keep them), so sending
   * the same bytes twice never runs them twice. A node that refuses it throws
   * a {@link SuiGraphqlError} carrying its reason.
   */
  async execute(
    txBytes: string,
    signature: string,
  ): Promise<SuiExecutionStatus> {
    await this.assertChain();
    const data = await this.post<{
      executeTransaction: {
        effects: { status: SuiExecutionStatus } | null;
      } | null;
    }>(
      `mutation ($tx: Base64!, $sigs: [Base64!]!) {
        executeTransaction(transactionDataBcs: $tx, signatures: $sigs) {
          effects { status }
        }
      }`,
      { tx: txBytes, sigs: [signature] },
    );
    const status = data.executeTransaction?.effects?.status;
    if (!status) {
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        `${SUI_TESTNET.testnetName} executed the transaction without effects`,
      );
    }
    return status;
  }
}
