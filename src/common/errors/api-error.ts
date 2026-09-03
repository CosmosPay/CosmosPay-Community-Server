import { STATUS_CODES } from 'node:http';
import { HttpException, HttpStatus } from '@nestjs/common';

/** "Conflict", "Not Found", … — the standard reason phrase for a status. */
function reasonPhrase(status: number): string {
  return STATUS_CODES[status] ?? 'Error';
}

/**
 * Machine-readable error codes.
 *
 * Every failure used to be an `HttpException` carrying English prose, so an
 * integrator could not tell "slippage exceeded" from "insufficient balance" from
 * "bad memo format" without substring-matching a sentence — they are all 400 —
 * and idempotency conflicts shared 409 with KYC state-machine violations. The
 * `code` is the stable contract; the message stays human and may be reworded.
 *
 * Codes are `snake_case`, grouped by domain, and must never be renamed once
 * published: an integrator's branch on `code` is exactly what they are for.
 *
 * A plain `enum`, deliberately, not a `const enum`. A const enum is erased at
 * compile time: it emits `declare const enum` into the .d.ts (unusable by any
 * consumer built with `isolatedModules`, and broken outright under an SWC
 * builder), and it leaves no runtime object — so the codes could not be
 * enumerated to publish them in the OpenAPI spec or ship them in an SDK. Since
 * these codes ARE the published contract, they have to exist at runtime.
 * `AdvisoryLockKey` is a plain enum for the same class of reason.
 */
export enum ApiErrorCode {
  // --- authorization -------------------------------------------------------
  InsufficientScope = 'insufficient_scope',
  NoAuthenticatedConsumer = 'no_authenticated_consumer',
  GatewayRequired = 'gateway_required',
  AdminCredentialsRequired = 'admin_credentials_required',
  AdminRoleRequired = 'admin_role_required',

  // --- resources -----------------------------------------------------------
  NotFound = 'not_found',
  ValidationFailed = 'validation_failed',

  // --- idempotency / concurrency -------------------------------------------
  IdempotencyConflict = 'idempotency_conflict',
  OperationInFlight = 'operation_in_flight',
  InvalidStateTransition = 'invalid_state_transition',

  // --- money / Stellar ------------------------------------------------------
  SlippageExceeded = 'slippage_exceeded',
  InsufficientBalance = 'insufficient_balance',
  NoPathFound = 'no_path_found',
  TrustlineMissing = 'trustline_missing',
  InvalidAmount = 'invalid_amount',
  InvalidMemo = 'invalid_memo',
  TransactionRejected = 'transaction_rejected',

  // --- provider / upstream --------------------------------------------------
  ProviderError = 'provider_error',
  ProviderUnavailable = 'provider_unavailable',
  QuoteNotFound = 'quote_not_found',

  // --- KYC ------------------------------------------------------------------
  KycStateInvalid = 'kyc_state_invalid',
  KycReviewRequired = 'kyc_review_required',
  /**
   * An operator disabled this fiat account. Distinct from `insufficient_scope`,
   * which is what a bare 403 used to report — sending integrators off to
   * re-provision an API key when the cause was a kill switch they cannot see.
   */
  AccountDisabled = 'account_disabled',

  // --- webhooks --------------------------------------------------------------
  /** The delivery body was cleared by retention and can no longer be re-sent. */
  PayloadExpired = 'payload_expired',

  // --- throttling -----------------------------------------------------------
  /**
   * This service refused the request to protect something it cannot undo — an
   * account created on-chain, XLM spent out of a funding wallet. Distinct from
   * `provider_unavailable`, which used to be the fallback for 429 and sent
   * integrators off to investigate an upstream that was perfectly healthy.
   */
  RateLimited = 'rate_limited',

  // --- service --------------------------------------------------------------
  Misconfigured = 'misconfigured',
  Internal = 'internal_error',
}

/**
 * The wire shape every error response takes. `AllExceptionsFilter` produces this
 * for plain `HttpException`s too, defaulting `code` from the status, so the
 * envelope is uniform whether or not a throw site was migrated to `ApiError`.
 */
export interface ApiErrorBody {
  statusCode: number;
  code: string;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

/**
 * An `HttpException` that also carries a stable machine-readable `code`.
 *
 * Prefer the named constructors below over `new ApiError(...)` at call sites —
 * they keep status and code paired correctly, which is the part that is easy to
 * get wrong when a throw is copied.
 */
export class ApiError extends HttpException {
  readonly code: ApiErrorCode;

  constructor(
    status: HttpStatus,
    code: ApiErrorCode,
    message: string | string[],
  ) {
    // `error` must carry the HTTP reason phrase ("Conflict", "Not Found", …),
    // which is what Nest's own exceptions put there and what the documented
    // envelope promises. Omitting it does not leave the field absent — the
    // exception filter falls back to its initial value, so every migrated throw
    // site would report `"error": "Internal Server Error"` alongside a correct
    // 409 or 404. `STATUS_CODES` is the same table Nest derives its phrases
    // from, so the two stay consistent for un-migrated throws.
    super(
      { statusCode: status, code, error: reasonPhrase(status), message },
      status,
    );
    this.code = code;
  }

  static badRequest(code: ApiErrorCode, message: string | string[]): ApiError {
    return new ApiError(HttpStatus.BAD_REQUEST, code, message);
  }

  static notFound(message: string, code = ApiErrorCode.NotFound): ApiError {
    return new ApiError(HttpStatus.NOT_FOUND, code, message);
  }

  static conflict(code: ApiErrorCode, message: string): ApiError {
    return new ApiError(HttpStatus.CONFLICT, code, message);
  }

  static forbidden(code: ApiErrorCode, message: string): ApiError {
    return new ApiError(HttpStatus.FORBIDDEN, code, message);
  }

  static unauthorized(code: ApiErrorCode, message: string): ApiError {
    return new ApiError(HttpStatus.UNAUTHORIZED, code, message);
  }

  static unavailable(code: ApiErrorCode, message: string): ApiError {
    return new ApiError(HttpStatus.SERVICE_UNAVAILABLE, code, message);
  }

  static badGateway(code: ApiErrorCode, message: string): ApiError {
    return new ApiError(HttpStatus.BAD_GATEWAY, code, message);
  }
}

/**
 * Fallback `code` for exceptions thrown before/outside the `ApiError` migration,
 * so the field is always present and an integrator can rely on it existing.
 */
const CODE_BY_STATUS: Readonly<Record<number, ApiErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ApiErrorCode.ValidationFailed,
  [HttpStatus.UNAUTHORIZED]: ApiErrorCode.NoAuthenticatedConsumer,
  [HttpStatus.FORBIDDEN]: ApiErrorCode.InsufficientScope,
  [HttpStatus.NOT_FOUND]: ApiErrorCode.NotFound,
  [HttpStatus.CONFLICT]: ApiErrorCode.IdempotencyConflict,
  [HttpStatus.SERVICE_UNAVAILABLE]: ApiErrorCode.ProviderUnavailable,
  [HttpStatus.BAD_GATEWAY]: ApiErrorCode.ProviderError,
  // Without these three, an upstream timeout, an unprocessable body and a rate
  // limit all fell through to `internal_error` — telling an integrator their
  // own valid request hit a bug in this service.
  [HttpStatus.GATEWAY_TIMEOUT]: ApiErrorCode.ProviderUnavailable,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ApiErrorCode.ValidationFailed,
  [HttpStatus.TOO_MANY_REQUESTS]: ApiErrorCode.RateLimited,
};

export function defaultCodeForStatus(status: number): string {
  return CODE_BY_STATUS[status] ?? ApiErrorCode.Internal;
}
