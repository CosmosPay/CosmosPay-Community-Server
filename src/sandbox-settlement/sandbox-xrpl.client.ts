import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { callJsonRpc, type JsonRpcTarget } from '@/chains/json-rpc';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig } from '@/config/configuration';
import type { PaymentNetwork } from '@/payment-intents/payment-networks';
import { SANDBOX_NETWORKS } from '@/sandbox-settlement/sandbox-settlement.constants';
import type { SandboxXrplNetwork } from '@/sandbox-settlement/sandbox-xrpl.constants';

/** rippled answered with `status: "error"` (`actNotFound`, `txnNotFound`, ...). */
export class XrplRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly result: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'XrplRpcError';
  }
}

/** An account root, as the sandbox reads it. */
export interface XrplAccount {
  sequence: number;
  /** Drops. */
  balance: bigint;
  ownerCount: number;
  requireDestinationTag: boolean;
  depositAuth: boolean;
}

/** One trustline, from the account's side (a positive balance is held). */
export interface XrplTrustLine {
  account: string;
  currency: string;
  balance: string;
  limit: string;
  freezePeer: boolean;
}

/** One entry of `account_tx` (API v2). */
export interface XrplAccountTxEntry {
  validated?: boolean;
  close_time_iso?: string;
  hash?: string;
  tx_json?: Record<string, unknown>;
  meta?: {
    TransactionResult?: string;
    delivered_amount?: unknown;
  };
}

/** Where a transaction stands on the ledger. */
export type XrplTxLookup =
  | { found: true; validated: boolean; result: string | null }
  | { found: false; searchedAll: boolean };

/**
 * JSON-RPC access to the XRP Ledger TESTNET for the sandbox. Before the first
 * call it compares `server_info`'s `network_id` with the one in
 * `SANDBOX_NETWORKS` (1, the testnet), so a node on mainnet (0) or devnet is a
 * 503, never a payout there. Requests use API version 2.
 */
@Injectable()
export class SandboxXrplClient {
  private readonly checks = new Map<string, Promise<void>>();

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /** The network's sandbox entry; throws for one that is not the XRP Ledger. */
  network(id: PaymentNetwork): SandboxXrplNetwork {
    const entry = SANDBOX_NETWORKS[id];
    if (entry.kind !== 'xrpl') {
      throw new Error(`Sandbox network ${id} is not an XRP Ledger network`);
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

  /** One call, unchecked: rippled's error answer becomes an {@link XrplRpcError}. */
  private async raw<T>(
    id: PaymentNetwork,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const result = await callJsonRpc<Record<string, unknown>>(
      this.target(id),
      method,
      [{ api_version: 2, ...params }],
    );
    if (result.status === 'error') {
      const code = typeof result.error === 'string' ? result.error : 'unknown';
      const message =
        typeof result.error_message === 'string' ? result.error_message : code;
      throw new XrplRpcError(code, message, result);
    }
    return result as T;
  }

  private assertNetwork(id: PaymentNetwork): Promise<void> {
    const cached = this.checks.get(id);
    if (cached) return cached;
    const expected = this.network(id).networkId;
    const check = this.raw<{ info?: { network_id?: number } }>(
      id,
      'server_info',
      {},
    ).then((answer) => {
      const served = answer.info?.network_id;
      if (served !== expected) {
        throw ApiError.misconfigured(
          'The sandbox cannot reach this test network right now.',
          `The sandbox node for ${id} serves XRP Ledger network ${served ?? 'unknown'}, ` +
            `not ${expected}: check SANDBOX_RPC_URLS.`,
        );
      }
    });
    this.checks.set(id, check);
    check.catch(() => this.checks.delete(id));
    return check;
  }

  /** A checked call. */
  async call<T>(
    id: PaymentNetwork,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    await this.assertNetwork(id);
    return this.raw<T>(id, method, params);
  }

  /** The account root; null while the account does not exist (`actNotFound`). */
  async account(
    id: PaymentNetwork,
    address: string,
    ledger: 'validated' | 'current' = 'validated',
  ): Promise<XrplAccount | null> {
    try {
      const answer = await this.call<{
        account_data: { Sequence: number; Balance: string; OwnerCount: number };
        account_flags?: {
          requireDestinationTag?: boolean;
          depositAuth?: boolean;
        };
      }>(id, 'account_info', { account: address, ledger_index: ledger });
      return {
        sequence: answer.account_data.Sequence,
        balance: BigInt(answer.account_data.Balance),
        ownerCount: answer.account_data.OwnerCount,
        requireDestinationTag:
          answer.account_flags?.requireDestinationTag === true,
        depositAuth: answer.account_flags?.depositAuth === true,
      };
    } catch (err) {
      if (err instanceof XrplRpcError && err.code === 'actNotFound') {
        return null;
      }
      throw err;
    }
  }

  /**
   * The account's trustline with `issuer` for `currency` (validated); null
   * when it has none, `undefined` when the account does not exist.
   */
  async trustLine(
    id: PaymentNetwork,
    address: string,
    issuer: string,
    currency: string,
  ): Promise<XrplTrustLine | null | undefined> {
    let answer: {
      lines: {
        account: string;
        currency: string;
        balance: string;
        limit: string;
        freeze_peer?: boolean;
      }[];
    };
    try {
      answer = await this.call(id, 'account_lines', {
        account: address,
        peer: issuer,
        ledger_index: 'validated',
      });
    } catch (err) {
      if (err instanceof XrplRpcError && err.code === 'actNotFound') {
        return undefined;
      }
      throw err;
    }
    const line = answer.lines.find(
      (l) =>
        l.account === issuer &&
        l.currency.toUpperCase() === currency.toUpperCase(),
    );
    return line
      ? {
          account: line.account,
          currency: line.currency,
          balance: line.balance,
          limit: line.limit,
          freezePeer: line.freeze_peer === true,
        }
      : null;
  }

  /** The reserve an account keeps, in drops: base + one increment per object. */
  async reserves(
    id: PaymentNetwork,
  ): Promise<{ base: bigint; increment: bigint }> {
    const answer = await this.call<{
      info: {
        validated_ledger?: {
          reserve_base_xrp?: number;
          reserve_inc_xrp?: number;
        };
      };
    }>(id, 'server_info', {});
    const ledger = answer.info.validated_ledger ?? {};
    const drops = (xrp: number | undefined) =>
      BigInt(Math.round((xrp ?? 0) * 1_000_000));
    return {
      base: drops(ledger.reserve_base_xrp),
      increment: drops(ledger.reserve_inc_xrp),
    };
  }

  /** What a transaction pays to enter the open ledger now, in drops, and its index. */
  async fee(id: PaymentNetwork): Promise<{
    openLedgerFee: bigint;
    baseFee: bigint;
    currentLedger: number;
  }> {
    const answer = await this.call<{
      drops: { open_ledger_fee: string; base_fee: string };
      ledger_current_index: number;
    }>(id, 'fee', {});
    return {
      openLedgerFee: BigInt(answer.drops.open_ledger_fee),
      baseFee: BigInt(answer.drops.base_fee),
      currentLedger: answer.ledger_current_index,
    };
  }

  /** One page of an account's validated history, newest first. */
  async accountTx(
    id: PaymentNetwork,
    address: string,
    limit: number,
    marker?: unknown,
  ): Promise<{ transactions: XrplAccountTxEntry[]; marker?: unknown }> {
    const answer = await this.call<{
      transactions: XrplAccountTxEntry[];
      marker?: unknown;
    }>(id, 'account_tx', {
      account: address,
      ledger_index_min: -1,
      ledger_index_max: -1,
      forward: false,
      limit,
      ...(marker === undefined ? {} : { marker }),
    });
    return { transactions: answer.transactions ?? [], marker: answer.marker };
  }

  /**
   * A transaction by hash, searched in `[minLedger, maxLedger]` (at most 1000
   * ledgers): not found with `searchedAll` means the node holds every one of
   * those ledgers, validated, and the transaction is in none of them.
   */
  async tx(
    id: PaymentNetwork,
    hash: string,
    range?: { minLedger: number; maxLedger: number },
  ): Promise<XrplTxLookup> {
    try {
      const answer = await this.call<{
        validated?: boolean;
        meta?: { TransactionResult?: string };
      }>(id, 'tx', {
        transaction: hash,
        ...(range
          ? { min_ledger: range.minLedger, max_ledger: range.maxLedger }
          : {}),
      });
      return {
        found: true,
        validated: answer.validated === true,
        result: answer.meta?.TransactionResult ?? null,
      };
    } catch (err) {
      if (err instanceof XrplRpcError && err.code === 'txnNotFound') {
        return { found: false, searchedAll: err.result.searched_all === true };
      }
      throw err;
    }
  }

  /**
   * Submits a signed blob and answers rippled's preliminary engine result
   * (`tesSUCCESS`, `terQUEUED`, `tefPAST_SEQ`, ...). Only a transaction the
   * node cannot parse at all is an error here; what the code means is the
   * caller's to decide.
   */
  async submit(
    id: PaymentNetwork,
    blob: string,
  ): Promise<{ engineResult: string; message: string }> {
    try {
      const answer = await this.call<{
        engine_result?: string;
        engine_result_message?: string;
      }>(id, 'submit', { tx_blob: blob });
      return {
        engineResult: answer.engine_result ?? 'unknown',
        message: answer.engine_result_message ?? '',
      };
    } catch (err) {
      throw err instanceof XrplRpcError
        ? ApiError.badGateway(
            ApiErrorCode.ProviderError,
            `${this.network(id).testnetName} refused the transaction: ${err.message}`,
          )
        : err;
    }
  }
}
