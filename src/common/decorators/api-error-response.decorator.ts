import { ApiResponse, type HeadersObject } from '@nestjs/swagger';
import { ApiErrorCode } from '@/common/errors/api-error';
import { API_ERROR_BODY_SCHEMA } from '@/common/errors/api-error.entity';
import {
  API_ERROR_CASES,
  apiErrorDescription,
  apiErrorExamples,
  RATE_LIMITED_RESPONSE_HEADERS,
  type ApiErrorExampleOverrides,
} from '@/common/errors/api-error.responses';

export interface ApiErrorResponseOptions {
  /** The status the route returns these codes with. */
  status: number;
  /**
   * The codes this route can return at that status — the ones its own service
   * throws, not the ones every route shares. `swagger.ts` attaches the shared
   * ones (`validation_failed`, `insufficient_scope`, `not_found`, …) on its
   * own; listing them here as well is how a description ends up promising a
   * failure the route cannot produce.
   */
  codes: readonly ApiErrorCode[];
  /**
   * Prose for this route specifically — when the recovery differs from what
   * the code's own one-liner says, which is the usual reason to write one.
   * Omitted, the description is built from the codes.
   */
  description?: string;
  /**
   * Response headers this status carries. A 429 gets `Retry-After` and the
   * `ratelimit-*` triple without asking — the guard always sends them, and a
   * route that documented its own 429 used to silently drop them.
   */
  headers?: HeadersObject;
  /**
   * Per-code `message` / `path` for a route that phrases a code its own way.
   * Everything else in the example still comes from the table, so `statusCode`,
   * `error` and `code` cannot be made to disagree with each other by hand.
   */
  examples?: ApiErrorExampleOverrides;
}

/**
 * Documents a failure THIS route produces, with the envelope integrators
 * actually receive.
 *
 * Reach for it only where the route's own service throws something the shared
 * baseline cannot know about — a 409 from an idempotency key, a 400 from a
 * state machine, a 403 from a kill switch. Everything a guard or the validation
 * pipe can return is attached to every operation centrally, so repeating it
 * here only creates a second copy to keep true.
 *
 *   @ApiErrorResponse({ status: 409, codes: [ApiErrorCode.IdempotencyConflict] })
 *
 * This is deliberately not `@ApiResponse({ content: … })` written out by hand:
 * that is how the spec ended up documenting a status with no example, or with
 * an example belonging to a different status.
 */
export const ApiErrorResponse = (options: ApiErrorResponseOptions) => {
  for (const code of options.codes) {
    // A documented failure that cannot occur is the bug this whole file exists
    // to prevent, so it fails at import time rather than shipping in the spec.
    if (!API_ERROR_CASES[code].statuses.includes(options.status)) {
      throw new Error(
        `${code} is never returned with ${options.status} — it arrives with ` +
          `${API_ERROR_CASES[code].statuses.join(', ')}. Fix the status, or ` +
          `add it to API_ERROR_CASES.`,
      );
    }
  }

  const headers =
    options.headers ??
    (options.status === 429 ? RATE_LIMITED_RESPONSE_HEADERS : undefined);

  return ApiResponse({
    status: options.status,
    description: options.description ?? apiErrorDescription(options.codes),
    ...(headers ? { headers } : {}),
    schema: API_ERROR_BODY_SCHEMA,
    examples: apiErrorExamples(options.status, options.codes, options.examples),
  });
};
