import {
  type ContentObject,
  type HeadersObject,
  type ResponseObject,
} from '@nestjs/swagger';
import {
  ApiErrorCode,
  reasonPhrase,
  type ApiErrorBody,
} from '@/common/errors/api-error';
import { API_ERROR_BODY_SCHEMA } from '@/common/errors/api-error.entity';
import { RATE_LIMIT_HEADER } from '@/common/rate-limit.constants';

/**
 * What every documented failure looks like on the wire, one entry per
 * `ApiErrorCode`.
 *
 * The spec used to publish ONE example — a 409 `idempotency_conflict`, carried
 * by the envelope schema's property examples — and attach that schema to every
 * status of every route. So Swagger UI and Postman showed "A swap already
 * exists for this Idempotency-Key" as the sample body of a 401, a 404 and a
 * 500, on routes that have no idempotency at all. Nothing an integrator read
 * there was true except the field names.
 *
 * The table is a `Record<ApiErrorCode, …>` on purpose: it is not optional
 * documentation that may lag behind, it is exhaustive, so adding a code to the
 * enum fails `tsc --noEmit` until the code says what it looks like returned.
 *
 * Messages are the real ones from the throw sites with the interpolated parts
 * filled in — an example that cannot occur is worse than no example at all.
 */
interface ApiErrorCase {
  /**
   * Every status this code can arrive with, the usual one first. One code is
   * not one status: `provider_unavailable` is a 503 from this service's own
   * guards, a 502 when the provider's socket fails, and a 504 when it times
   * out. `apiErrorExample` stamps in the status it is asked for, so a published
   * example always agrees with the response it sits under.
   */
  statuses: readonly number[];
  /** One line, shown in the Swagger UI / Postman example picker. */
  summary: string;
  /** Verbatim from the throw site, with the interpolated parts filled in. */
  message: string | string[];
  /** A path this code is really returned from — the envelope carries one. */
  path: string;
}

/**
 * Fixed, so regenerating the spec is deterministic and `openapi:check` does not
 * fail on the clock. A real envelope carries `new Date().toISOString()`.
 */
export const API_ERROR_EXAMPLE_TIMESTAMP = '2026-09-01T12:00:00.000Z';

export const API_ERROR_CASES: Readonly<Record<ApiErrorCode, ApiErrorCase>> = {
  // --- authorization -------------------------------------------------------
  [ApiErrorCode.InsufficientScope]: {
    statuses: [403],
    summary: 'The API key does not hold the scope this route requires',
    message: 'This API key is missing the required scope(s): swaps:write',
    path: '/v1/swaps',
  },
  [ApiErrorCode.NoAuthenticatedConsumer]: {
    statuses: [401],
    summary: 'The gateway forwarded no API key identity',
    message: 'No authenticated consumer',
    path: '/v1/swaps',
  },
  [ApiErrorCode.GatewayRequired]: {
    statuses: [403],
    summary: 'The request did not arrive through the APISIX gateway',
    message: 'Request did not originate from the gateway',
    path: '/v1/swaps',
  },
  [ApiErrorCode.AdminConsoleOnly]: {
    statuses: [403],
    summary:
      'The route belongs to the platform console; no API key may call it',
    message: 'This endpoint is reserved for the platform console',
    path: '/v1/aliases/alice/recovery/complete',
  },
  [ApiErrorCode.ElevatedKeyRequired]: {
    statuses: [403],
    summary: 'The route writes to something every tenant shares',
    message:
      'Registering Pollar users requires an elevated (admin) key: the Pollar ' +
      'user directory is shared by every tenant.',
    path: '/v1/pollar/users',
  },

  // --- resources -----------------------------------------------------------
  [ApiErrorCode.NotFound]: {
    statuses: [404],
    summary: 'No such resource — or it belongs to another consumer',
    message: 'Payment intent pi_7Yc3Qn0Kx2 not found',
    path: '/v1/payment-intents/pi_7Yc3Qn0Kx2',
  },
  [ApiErrorCode.ValidationFailed]: {
    statuses: [400],
    summary: 'The body, query or headers failed validation',
    // An array: this is what class-validator produces, and it is the one shape
    // an integrator has to special-case when rendering `message`.
    message: [
      'amount must be a positive decimal string',
      'destination must be a valid Stellar public key',
    ],
    path: '/v1/swaps',
  },
  [ApiErrorCode.PayloadTooLarge]: {
    statuses: [413],
    summary: 'The upload is larger than the route accepts',
    message: 'File too large',
    path: '/v1/kyc/upload',
  },

  // --- idempotency / concurrency -------------------------------------------
  [ApiErrorCode.IdempotencyConflict]: {
    statuses: [409],
    summary: 'This Idempotency-Key was already used for a different request',
    message: 'A swap already exists for this Idempotency-Key',
    path: '/v1/swaps',
  },
  [ApiErrorCode.OperationInFlight]: {
    statuses: [409],
    summary: 'A conflicting operation is still settling',
    message:
      'A withdrawal from this pool is already in flight for this account. ' +
      'Wait for it to settle or expire before starting another — the ' +
      'commission on a withdrawal depends on the position it leaves behind.',
    path: '/v1/liquidity-pools/withdraw',
  },
  [ApiErrorCode.InvalidStateTransition]: {
    statuses: [400],
    summary: 'The resource cannot move to that state from the one it is in',
    message:
      'txHash cannot be changed on a SUCCEEDED payment intent: the status is ' +
      'terminal',
    path: '/v1/payment-intents/pi_7Yc3Qn0Kx2',
  },

  // --- money / Stellar ------------------------------------------------------
  [ApiErrorCode.SlippageExceeded]: {
    statuses: [400],
    summary: 'The requested slippage is above what this service allows',
    message: 'slippageBps 900 exceeds the maximum allowed (500)',
    path: '/v1/swaps/quote',
  },
  [ApiErrorCode.InsufficientBalance]: {
    statuses: [400],
    summary: 'The source account cannot cover the amount',
    message:
      'Account GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ ' +
      'holds only 12.5000000 shares of this pool',
    path: '/v1/liquidity-pools/withdraw',
  },
  [ApiErrorCode.NoPathFound]: {
    statuses: [400],
    summary: 'Horizon found no payment path for this pair and amount',
    message: 'No swap path found for this asset pair and amount',
    path: '/v1/swaps/quote',
  },
  [ApiErrorCode.TrustlineMissing]: {
    statuses: [400],
    summary: 'The account must trust the asset before it can hold it',
    message:
      'Destination GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ ' +
      'has no trustline for ' +
      'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 — it ' +
      'must trust the asset before it can receive the swap',
    path: '/v1/swaps',
  },
  [ApiErrorCode.InvalidAmount]: {
    statuses: [400],
    summary: 'Not a Stellar amount, or not greater than zero',
    message: 'Deposit amounts must be greater than zero',
    path: '/v1/liquidity-pools/deposit',
  },
  [ApiErrorCode.InvalidMemo]: {
    statuses: [400],
    summary: 'The memo is not the type this route requires',
    message: 'memo must be a MEMO_ID: a numeric uint64',
    path: '/v1/payment-intents/pay',
  },
  [ApiErrorCode.TransactionRejected]: {
    statuses: [400],
    summary: 'The submitted transaction does not do what the route needs',
    message:
      'The transaction does not settle this payment intent: the amount paid ' +
      'is below the amount requested',
    path: '/v1/payment-intents/pi_7Yc3Qn0Kx2/validate',
  },

  // --- provider / upstream --------------------------------------------------
  [ApiErrorCode.ProviderError]: {
    statuses: [502],
    summary: 'The upstream provider refused the request',
    message: 'The payment provider rejected the request.',
    path: '/v1/onramp/quotes',
  },
  [ApiErrorCode.ProviderUnavailable]: {
    statuses: [503, 502, 504],
    summary: 'The upstream provider could not be reached, or timed out',
    message: 'Could not reach the payment provider.',
    path: '/v1/onramp/quotes',
  },
  [ApiErrorCode.QuoteNotFound]: {
    statuses: [404],
    summary: 'The quote expired, or never existed',
    message: 'Quote not found',
    path: '/v1/onramp/payins',
  },

  // --- KYC ------------------------------------------------------------------
  [ApiErrorCode.KycStateInvalid]: {
    statuses: [409],
    summary: 'An illegal KYC state transition — not a duplicate request',
    message: "Cannot move receiver from 'approved' to 'pending'",
    path: '/v1/kyc/receivers/rc_4Kd9Wp1Lm3',
  },
  [ApiErrorCode.KycReviewRequired]: {
    statuses: [403],
    summary: 'The change has to be signed off with an elevated (admin) key',
    message:
      'Approving a receiver requires an elevated (admin) key: the KYC review ' +
      'must be signed off by someone other than the key that submitted it.',
    path: '/v1/kyc/receivers/rc_4Kd9Wp1Lm3/approve',
  },
  [ApiErrorCode.AccountDisabled]: {
    statuses: [403],
    summary: 'An operator disabled this fiat account — not a key problem',
    message:
      'This fiat account is disabled. Re-enable it to use onramp/offramp.',
    path: '/v1/onramp/quotes',
  },

  // --- webhooks --------------------------------------------------------------
  [ApiErrorCode.PayloadExpired]: {
    statuses: [409],
    summary: 'The delivery body is past retention and cannot be re-sent',
    message:
      'Delivery wd_8Rt2Vy6Hn4 is past its retention window: the event body ' +
      'was cleared and can no longer be re-sent.',
    path: '/v1/webhooks/we_5Mq0Zb3Jc7/deliveries/wd_8Rt2Vy6Hn4/redeliver',
  },

  // --- throttling -----------------------------------------------------------
  [ApiErrorCode.RateLimited]: {
    statuses: [429],
    summary: 'This route’s budget for this caller is spent',
    message: 'Too many requests. Retry in 42s.',
    path: '/v1/swaps',
  },

  // --- aliases ---------------------------------------------------------------
  [ApiErrorCode.AliasTaken]: {
    statuses: [409],
    summary: 'The handle is already claimed — first claim wins',
    message: 'The alias "alice" is already claimed.',
    path: '/v1/aliases',
  },
  [ApiErrorCode.AliasNameInvalid]: {
    statuses: [400],
    summary: 'Reserved, malformed, or the wrong length',
    message:
      'An alias may use a-z, 0-9 and underscores, and must start and end ' +
      'with a letter or digit.',
    path: '/v1/aliases',
  },
  [ApiErrorCode.AliasChallengeInvalid]: {
    statuses: [400],
    summary:
      'No challenge, expired, already spent, or issued for other details',
    message:
      'The challenge is unknown, expired, already used, or was issued for ' +
      'different details.',
    path: '/v1/aliases',
  },
  [ApiErrorCode.AliasSignatureInvalid]: {
    statuses: [400],
    summary: 'The signature does not verify against the claiming address',
    message:
      'The signature does not verify against the address that is claiming.',
    path: '/v1/aliases',
  },
  [ApiErrorCode.AliasRecoveryInvalid]: {
    statuses: [400],
    summary: 'The recovery token is unknown, expired or already spent',
    message: 'The recovery token is unknown, expired or already used.',
    path: '/v1/aliases/alice/recovery/complete',
  },
  [ApiErrorCode.AliasAddressConflict]: {
    statuses: [400],
    summary: 'The address is already on the alias, or the alias is at its cap',
    message: 'That address is already on this alias for that network.',
    path: '/v1/aliases/alice/addresses',
  },

  // --- Pollar ----------------------------------------------------------------
  [ApiErrorCode.PollarIdentityRequired]: {
    statuses: [403],
    summary: 'The key has no account email to tie a Pollar login to',
    message:
      'This key has no account email, so a Pollar login cannot be tied to it. ' +
      'Social login is only available to the account that owns the key.',
    path: '/v1/pollar/oauth/authorize',
  },
  [ApiErrorCode.PollarIdentityMismatch]: {
    statuses: [403],
    summary: 'Someone other than the key’s account completed the login',
    message:
      'This Pollar login was completed by a different account than the one ' +
      'that owns this key, so no session is returned. Sign in with the email ' +
      "of the key's account.",
    path: '/v1/pollar/oauth/token',
  },

  // --- service --------------------------------------------------------------
  [ApiErrorCode.Misconfigured]: {
    statuses: [503],
    summary: 'A server-side configuration error — retrying will not help',
    message:
      'BlindPay (prod) is not configured: set BLINDPAY_INSTANCE_ID_PROD.',
    path: '/v1/onramp/quotes',
  },
  [ApiErrorCode.Internal]: {
    statuses: [500],
    summary: 'Unexpected server error — the detail is logged, never returned',
    message: 'Internal server error',
    path: '/v1/swaps',
  },
};

/**
 * The IETF triple `RateLimitGuard` sets on the way out — on a successful
 * response as much as on a refusal, which is the point: a client that reads
 * them paces itself instead of being refused. Spelled from the constants the
 * guard uses, so the two cannot drift; HTTP header names are case-insensitive.
 */
export const RATE_LIMIT_RESPONSE_HEADERS: HeadersObject = {
  [RATE_LIMIT_HEADER.limit]: {
    description: 'Requests allowed in the current window.',
    schema: { type: 'integer', example: 30 },
  },
  [RATE_LIMIT_HEADER.remaining]: {
    description: 'Requests left in the current window.',
    schema: { type: 'integer', example: 0 },
  },
  [RATE_LIMIT_HEADER.reset]: {
    description: 'Seconds until the window resets.',
    schema: { type: 'integer', example: 42 },
  },
};

/** What a 429 carries: the triple, plus RFC 9110's `Retry-After`. */
export const RATE_LIMITED_RESPONSE_HEADERS: HeadersObject = {
  [RATE_LIMIT_HEADER.retryAfter]: {
    description:
      'Seconds to wait before retrying. The only one a browser or a naive ' +
      'retry loop honours — prefer it.',
    schema: { type: 'integer', example: 42 },
  },
  ...RATE_LIMIT_RESPONSE_HEADERS,
};

/**
 * The envelope this service would really send for `code` at `status`.
 *
 * The status is stamped into `statusCode` and `error` rather than read from the
 * case, so an example is always consistent with the response it is published
 * under — including for the codes that arrive with more than one status.
 */
export function apiErrorExample(
  code: ApiErrorCode,
  status: number = API_ERROR_CASES[code].statuses[0],
): ApiErrorBody {
  const example = API_ERROR_CASES[code];
  return {
    statusCode: status,
    code,
    error: reasonPhrase(status),
    message: example.message,
    path: example.path,
    timestamp: API_ERROR_EXAMPLE_TIMESTAMP,
  };
}

/**
 * What a route returns instead of the table's default, for a code whose message
 * or path is specific to it.
 *
 * The table holds one case per code because a code means one thing; but a few
 * routes phrase it their own way — the readiness probe answers
 * `provider_unavailable` with the generic exception text, never "could not
 * reach the payment provider". Overriding is how such a route documents what it
 * really sends rather than something close to it.
 */
export type ApiErrorExampleOverrides = Partial<
  Record<
    ApiErrorCode,
    Partial<Pick<ApiErrorCase, 'summary' | 'message' | 'path'>>
  >
>;

/**
 * Keyed by the code itself, so the picker reads as the list of codes. Narrower
 * than OpenAPI's `ExamplesObject`, which also admits a `$ref` — `@ApiResponse`
 * does not take one, and every example here is a literal envelope anyway.
 */
export function apiErrorExamples(
  status: number,
  codes: readonly ApiErrorCode[],
  overrides: ApiErrorExampleOverrides = {},
): Record<string, { summary: string; value: ApiErrorBody }> {
  const examples: Record<string, { summary: string; value: ApiErrorBody }> = {};
  for (const code of codes) {
    const override = overrides[code];
    examples[code] = {
      summary: `${code} — ${override?.summary ?? API_ERROR_CASES[code].summary}`,
      value: {
        ...apiErrorExample(code, status),
        ...pickExampleFields(override),
      },
    };
  }
  return examples;
}

/** `summary` describes the example; it is not part of the envelope. */
function pickExampleFields(
  override: ApiErrorExampleOverrides[ApiErrorCode],
): Partial<ApiErrorBody> {
  return {
    ...(override?.message !== undefined ? { message: override.message } : {}),
    ...(override?.path !== undefined ? { path: override.path } : {}),
  };
}

/** `content` for a failure body: the shared envelope schema plus the examples. */
export function apiErrorContent(
  status: number,
  codes: readonly ApiErrorCode[],
): ContentObject {
  return {
    'application/json': {
      schema: API_ERROR_BODY_SCHEMA,
      examples: apiErrorExamples(status, codes),
    },
  };
}

/**
 * The description a status gets when the route does not write its own: every
 * code it can carry, each with its one-liner. Markdown, which is what Swagger
 * UI renders.
 */
export function apiErrorDescription(codes: readonly ApiErrorCode[]): string {
  return codes
    .map((code) => `\`${code}\` — ${API_ERROR_CASES[code].summary}`)
    .join('\n\n');
}

/** A complete `ResponseObject` for one status. */
export function apiErrorResponse(
  status: number,
  codes: readonly ApiErrorCode[],
  options: { description?: string; headers?: ResponseObject['headers'] } = {},
): ResponseObject {
  return {
    description: options.description ?? apiErrorDescription(codes),
    ...(options.headers ? { headers: options.headers } : {}),
    content: apiErrorContent(status, codes),
  };
}
