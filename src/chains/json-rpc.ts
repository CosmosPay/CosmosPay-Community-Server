import { HttpStatus } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { CHAIN_RPC_MAX_RESPONSE_BYTES } from '@/chains/chains.constants';

/**
 * The node answered, with a JSON-RPC error object. Distinct from a transport
 * failure: "the node says no" is information about the request, "the node did
 * not answer" is information about the node — the confusion that once let an
 * observer expire payments that had settled.
 */
export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

export interface JsonRpcTarget {
  /** Which chain's node, for the error a caller sees ("Solana RPC …"). */
  provider: string;
  url: string;
  timeoutMs: number;
}

let nextId = 1;

/**
 * One JSON-RPC 2.0 call over HTTPS. Transport failures become the upstream
 * errors the contract documents for the route — 503 unreachable or throttled,
 * 504 timed out, 502 a body that is not JSON-RPC — and a JSON-RPC `error`
 * object becomes a {@link JsonRpcError} for the caller to interpret, since
 * only it knows whether "not found" is an answer or a fault.
 *
 * The node URL is the operator's, from configuration; nothing a caller sends
 * reaches it except as a parameter.
 */
export async function callJsonRpc<T>(
  target: JsonRpcTarget,
  method: string,
  params: unknown[],
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal: AbortSignal.timeout(target.timeoutMs),
      redirect: 'error',
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new ApiError(
        HttpStatus.GATEWAY_TIMEOUT,
        ApiErrorCode.ProviderUnavailable,
        `${target.provider} RPC did not answer ${method} in time`,
      );
    }
    throw ApiError.unavailable(
      ApiErrorCode.ProviderUnavailable,
      `${target.provider} RPC is unreachable`,
    );
  }

  if (response.status === 429 || response.status >= 500) {
    throw ApiError.unavailable(
      ApiErrorCode.ProviderUnavailable,
      `${target.provider} RPC is unavailable (HTTP ${response.status})`,
    );
  }

  const text = await response.text();
  if (text.length > CHAIN_RPC_MAX_RESPONSE_BYTES) {
    throw ApiError.badGateway(
      ApiErrorCode.ProviderError,
      `${target.provider} RPC answered ${method} with an oversized body`,
    );
  }

  let body: {
    result?: T;
    error?: { code?: number; message?: string; data?: unknown };
  };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw ApiError.badGateway(
      ApiErrorCode.ProviderError,
      `${target.provider} RPC answered ${method} with a body that is not JSON`,
    );
  }

  if (body.error) {
    throw new JsonRpcError(
      typeof body.error.code === 'number' ? body.error.code : 0,
      body.error.message ?? 'JSON-RPC error',
      body.error.data,
    );
  }
  if (!response.ok || !('result' in body)) {
    throw ApiError.badGateway(
      ApiErrorCode.ProviderError,
      `${target.provider} RPC answered ${method} without a result (HTTP ${response.status})`,
    );
  }
  return body.result as T;
}

/** A JSON-RPC error the caller did not expect, as the 502 a route reports. */
export function unexpectedRpcError(
  provider: string,
  method: string,
  err: unknown,
): ApiError {
  const detail = err instanceof Error ? err.message : String(err);
  return ApiError.badGateway(
    ApiErrorCode.ProviderError,
    `${provider} RPC refused ${method}: ${detail}`,
  );
}

/**
 * JSON-RPC codes a node answers a broadcast with when it is throttling, not
 * judging the transaction: -32005 "limit exceeded" (EIP-1474) and -32029, the
 * rate-limit code Solana RPC providers use.
 */
const RATE_LIMIT_CODES = new Set([-32005, -32029]);

/**
 * What a refused broadcast means for the caller. The node read the signed
 * transaction and said no — a spent blockhash, a nonce already used, no gas
 * money, a failed simulation — which is a 400 carrying its reason, not the 502
 * of a node that is down. A node that is only throttling stays a 503.
 */
export function broadcastRejected(
  provider: string,
  err: JsonRpcError,
): ApiError {
  if (RATE_LIMIT_CODES.has(err.code)) {
    return ApiError.unavailable(
      ApiErrorCode.ProviderUnavailable,
      `${provider} RPC is rate limiting this service. Retry shortly.`,
    );
  }
  return ApiError.badRequest(
    ApiErrorCode.TransactionRejected,
    `${provider} rejected the transaction: ${err.message}`,
  );
}
