/** Horizon's `extras.result_codes`, which moves depending on the SDK path. */
interface ResultCodes {
  transaction?: string;
  operations?: string[];
}

/** The HTTP status of a failed Horizon call, when there was one. */
export function horizonStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status;
}

/**
 * True only when Horizon positively answered "not found".
 *
 * The distinction matters: a 404 is information about the chain, while a 429 or
 * a timeout is information about *us*. Conflating them is how the settlement
 * observer used to expire transactions that had actually settled.
 */
export function isHorizonNotFound(err: unknown): boolean {
  return horizonStatus(err) === 404;
}

/**
 * Pulls the transaction/operation result codes off a rejected submission.
 *
 * The SDK puts them in one of two places depending on the call path, which is
 * why this reads both — a detail that was replicated verbatim in swaps and in
 * liquidity pools.
 */
export function extractResultCodes(err: unknown): string[] | null {
  const response = (
    err as {
      response?: {
        data?: { extras?: { result_codes?: ResultCodes } };
        extras?: { result_codes?: ResultCodes };
      };
    }
  )?.response;
  const rc =
    response?.data?.extras?.result_codes ?? response?.extras?.result_codes;
  if (!rc) return null;
  const codes: string[] = [];
  if (rc.transaction) codes.push(rc.transaction);
  if (Array.isArray(rc.operations)) codes.push(...rc.operations);
  return codes.length ? codes : null;
}
