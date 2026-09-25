import { STATUS_CODES } from 'node:http';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * "Conflict", "Not Found", … — the standard reason phrase for a status.
 *
 * Exported because the published error examples carry the same `error` field a
 * real response does, and deriving it twice is how the two drift apart.
 */
export function reasonPhrase(status: number): string {
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
  /**
   * `/v1/admin` reached by something other than the platform console. It
   * replaces `admin_credentials_required` / `admin_role_required`, which named
   * a per-service admin secret that no longer exists.
   */
  AdminConsoleOnly = 'admin_console_only',
  /**
   * The route writes to something every tenant shares — today the Pollar
   * application's user directory — so only an elevated (admin) key may call it.
   * Distinct from `insufficient_scope`: granting the key more scopes would not
   * help.
   */
  ElevatedKeyRequired = 'elevated_key_required',

  // --- resources -----------------------------------------------------------
  NotFound = 'not_found',
  ValidationFailed = 'validation_failed',
  /**
   * The body exceeded a size the service enforces — today the KYC document
   * upload's file cap. Multer refuses it as a plain 413, which used to fall
   * through to `internal_error` and read as a bug in this service rather than a
   * limit the caller can stay inside.
   */
  PayloadTooLarge = 'payload_too_large',

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

  // --- aliases ---------------------------------------------------------------
  /** The handle is already claimed. First claim wins; there is no queue. */
  AliasTaken = 'alias_taken',
  /** Reserved, malformed, or too short/long — see `alias-name.ts` for the rule. */
  AliasNameInvalid = 'alias_name_invalid',
  /** No challenge, expired, already spent, or issued for a different name/address. */
  AliasChallengeInvalid = 'alias_challenge_invalid',
  /** The signature did not verify against the address that is claiming. */
  AliasSignatureInvalid = 'alias_signature_invalid',
  /** The recovery token is unknown, expired or spent. */
  AliasRecoveryInvalid = 'alias_recovery_invalid',
  /** This address is already on the alias, or the alias is at its address cap. */
  AliasAddressConflict = 'alias_address_conflict',

  // --- Pollar ----------------------------------------------------------------
  /**
   * The gateway forwarded no account email for this key, so a Pollar login
   * cannot be tied to the account that opened it. Every tenant shares one Pollar
   * application: a session handed to a key that cannot say whose it is would be
   * a session for whoever consented on its link.
   */
  PollarIdentityRequired = 'pollar_identity_required',
  /**
   * The person who completed the Pollar login is not the account that holds the
   * key. The session was revoked at Pollar and never returned.
   */
  PollarIdentityMismatch = 'pollar_identity_mismatch',

  // --- wallet sign-in --------------------------------------------------------
  /**
   * No handshake by that `state`, or one that has expired, failed or already
   * been redeemed.
   *
   * Deliberately ONE code for all of those. A wallet that could tell "expired"
   * from "already redeemed" from "never existed" could probe which `state`
   * values this service has seen, and none of the three changes what the wallet
   * does: start again.
   */
  WalletHandshakeInvalid = 'wallet_handshake_invalid',
  /**
   * The PKCE verifier does not hash to the challenge the handshake was opened
   * with. Whoever is redeeming is not the device that started it.
   */
  WalletVerifierInvalid = 'wallet_verifier_invalid',
  /** The emailed code is wrong, spent, expired, or its row is burned. */
  WalletLoginCodeInvalid = 'wallet_login_code_invalid',
  /**
   * Another code was sent to this mailbox moments ago. The cooldown is on the
   * ROW, so rotating a client address does not buy another email.
   */
  WalletLoginCodeCooldown = 'wallet_login_code_cooldown',
  /** The session token is forged, edited, expired, or was minted elsewhere. */
  WalletSessionInvalid = 'wallet_session_invalid',
  /**
   * The signature does not verify against the address it names, or the signed
   * timestamp sits outside the accepted window.
   */
  WalletSignatureInvalid = 'wallet_signature_invalid',
  /**
   * The backup box is not one the wallet could have produced — wrong version,
   * malformed, oversized, or sealed at a PBKDF2 cost below this service's floor.
   */
  WalletBackupInvalid = 'wallet_backup_invalid',
  /**
   * The account this sign-in resolves to is attached to a different Stellar
   * address, and no replacement was authorized. Replacing a backup is the
   * "forgot the password" door and is never taken implicitly.
   */
  WalletAccountMismatch = 'wallet_account_mismatch',
  /** This provider is not configured on this deployment. */
  WalletProviderUnavailable = 'wallet_provider_unavailable',
  /**
   * The operator will not sponsor this recovery setup: the account does not
   * exist yet, or it already has a signer besides its master key — sponsorship
   * is for turning recovery on once, not a repeatable way to fund signers.
   */
  WalletRecoverySetupRefused = 'wallet_recovery_setup_refused',

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
  // Raised by multer (via Nest's `PayloadTooLargeException`), never by a throw
  // site of ours, so the status is the only place a code can come from.
  [HttpStatus.PAYLOAD_TOO_LARGE]: ApiErrorCode.PayloadTooLarge,
};

export function defaultCodeForStatus(status: number): string {
  return CODE_BY_STATUS[status] ?? ApiErrorCode.Internal;
}
