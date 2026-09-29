import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SOLANA_GENESIS_HASHES } from '@/chains/chains.constants';
import {
  callJsonRpc,
  JsonRpcError,
  type JsonRpcTarget,
  unexpectedRpcError,
} from '@/chains/json-rpc';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import {
  SOLANA_COMMITMENT,
  SPL_TOKEN_PROGRAM_IDS,
} from '@/solana/solana.constants';

/** One entry of `meta.pre/postTokenBalances`. */
export interface SolanaTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/** An account key of a `jsonParsed` transaction message. */
export interface SolanaAccountKey {
  pubkey: string;
  signer: boolean;
  writable: boolean;
}

/** The parts of a `getTransaction` (`jsonParsed`) answer this service reads. */
export interface SolanaTransaction {
  slot: number;
  /** Unix seconds; null for a very old or not-yet-timed block. */
  blockTime: number | null;
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: SolanaTokenBalance[];
    postTokenBalances?: SolanaTokenBalance[];
  } | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: SolanaAccountKey[] };
  };
}

export interface SolanaSignatureInfo {
  signature: string;
  err: unknown;
  blockTime?: number | null;
}

/**
 * The Solana JSON-RPC, per network tier (`public` → mainnet-beta, `testnet` →
 * devnet). Every read goes through here, so the one place that knows the node
 * URLs is also the one that checks each node is on the cluster it is
 * configured for: before its first read of a tier, it compares the node's
 * genesis hash with the cluster's, and refuses to use a node that disagrees.
 */
@Injectable()
export class SolanaRpcClient {
  private readonly clusterChecks = new Map<StellarNetwork, Promise<void>>();

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private target(network: StellarNetwork): JsonRpcTarget {
    const solana = this.config.get('solana', { infer: true });
    return {
      provider: 'Solana',
      url: solana.rpcUrls[network],
      timeoutMs: solana.timeoutMs,
    };
  }

  private async call<T>(
    network: StellarNetwork,
    method: string,
    params: unknown[],
  ): Promise<T> {
    await this.assertCluster(network);
    return callJsonRpc<T>(this.target(network), method, params);
  }

  /**
   * Refuses a node on the wrong cluster. Cached per tier once it passes; a
   * failure is not cached, so a node that was down is asked again next time.
   */
  private assertCluster(network: StellarNetwork): Promise<void> {
    const cached = this.clusterChecks.get(network);
    if (cached) return cached;
    const check = callJsonRpc<string>(
      this.target(network),
      'getGenesisHash',
      [],
    ).then((genesis) => {
      if (genesis !== SOLANA_GENESIS_HASHES[network]) {
        throw ApiError.unavailable(
          ApiErrorCode.Misconfigured,
          `The Solana RPC configured for the ${network} tier serves a different ` +
            'cluster. Check SOLANA_RPC_URL_MAINNET / SOLANA_RPC_URL_DEVNET.',
        );
      }
    });
    this.clusterChecks.set(network, check);
    check.catch(() => this.clusterChecks.delete(network));
    return check;
  }

  /** A transaction by signature, or null when the cluster has none. */
  async getTransaction(
    network: StellarNetwork,
    signature: string,
  ): Promise<SolanaTransaction | null> {
    try {
      return await this.call<SolanaTransaction | null>(
        network,
        'getTransaction',
        [
          signature,
          {
            encoding: 'jsonParsed',
            commitment: SOLANA_COMMITMENT,
            maxSupportedTransactionVersion: 0,
          },
        ],
      );
    } catch (err) {
      // A malformed signature is refused as invalid params rather than "not
      // found" — for the caller it is the same: no such transaction.
      if (err instanceof JsonRpcError && err.code === -32602) return null;
      throw rpcFault(err, 'getTransaction');
    }
  }

  /** Newest-first signatures of transactions that touched `address`. */
  async getSignaturesForAddress(
    network: StellarNetwork,
    address: string,
    limit: number,
  ): Promise<SolanaSignatureInfo[]> {
    try {
      return await this.call<SolanaSignatureInfo[]>(
        network,
        'getSignaturesForAddress',
        [address, { limit, commitment: SOLANA_COMMITMENT }],
      );
    } catch (err) {
      throw rpcFault(err, 'getSignaturesForAddress');
    }
  }

  /**
   * An SPL mint's decimals, or null when `mint` is not a mint of the Token or
   * Token-2022 program — an account that does not exist, a wallet, a program.
   */
  async getMintDecimals(
    network: StellarNetwork,
    mint: string,
  ): Promise<number | null> {
    let account: {
      value: {
        owner: string;
        data: { parsed?: { type?: string; info?: { decimals?: unknown } } };
      } | null;
    };
    try {
      account = await this.call(network, 'getAccountInfo', [
        mint,
        { encoding: 'jsonParsed', commitment: SOLANA_COMMITMENT },
      ]);
    } catch (err) {
      throw rpcFault(err, 'getAccountInfo');
    }
    const value = account.value;
    if (
      !value ||
      !SPL_TOKEN_PROGRAM_IDS.includes(value.owner) ||
      value.data?.parsed?.type !== 'mint'
    ) {
      return null;
    }
    const decimals = value.data.parsed.info?.decimals;
    return typeof decimals === 'number' ? decimals : null;
  }
}

/** Anything but an upstream error the transport already shaped is a 502. */
function rpcFault(err: unknown, method: string): unknown {
  return err instanceof ApiError
    ? err
    : unexpectedRpcError('Solana', method, err);
}
