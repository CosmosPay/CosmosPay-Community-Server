import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { scrubUpstreamText } from '@/common/provider-names';

/** The longest upstream message relayed to a caller; anything longer is cut. */
const MAX_MESSAGE_LENGTH = 300;

/** One JSON call to a third-party HTTP API. */
export interface UpstreamRequest {
  /** How the LOGS name the provider ("NEAR Intents", "Jupiter", "Kuru Flow"). */
  provider: string;
  /**
   * How a CLIENT is told about it, naming no provider ("the cross-chain
   * route", "the Solana swap route"; `src/common/provider-names.ts`).
   */
  service: string;
  /** The env var holding its key, logged (never sent) when that key is refused. */
  keyEnv: string;
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  /**
   * Throw {@link UpstreamUnauthorized} on a 401 instead of `misconfigured`:
   * for a client whose bearer token expires, which signs in again once
   * before it calls the key wrong.
   */
  unauthorizedIsRetryable?: boolean;
  /**
   * Applied to the provider's own text before it is logged or relayed: for a
   * provider that may echo personal data it was sent (a tax id) in an error.
   */
  redact?: (text: string) => string;
  /**
   * The request or its answer carries a person's data (an email, a name, a
   * bank account, a bearer token of theirs). A failure is then logged by the
   * body's KEY NAMES and its error code alone, never its text, and every
   * status that is not 2xx (404 and 401 included) is thrown as an
   * {@link UpstreamStatusError} for the caller to map onto its own codes:
   * the default mapping relays the provider's reason, which may echo what it
   * was sent.
   */
  personalData?: boolean;
}

/** A provider's error code worth logging: a plain upper-case word (`INVALID_OTP`), never free text. */
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The provider answered a status a {@link UpstreamRequest.personalData}
 * request maps itself. It carries the status, the provider's error code when
 * that is a plain word, and the body's top-level key names; its message names
 * nothing else. The provider's text is held privately: {@link mentions} can
 * ask it about a word, and nothing logs or relays it.
 */
export class UpstreamStatusError extends Error {
  readonly #text: string;

  constructor(
    readonly provider: string,
    readonly status: number,
    readonly code: string | null,
    readonly keys: readonly string[],
    text: string,
  ) {
    super(`${provider} answered ${status}${code ? ` (${code})` : ''}`);
    this.#text = text;
  }

  /** Whether the provider's own text mentions `word`, in any case. */
  mentions(word: string): boolean {
    return this.#text.toLowerCase().includes(word.toLowerCase());
  }
}

/** The provider answered 404. Only some callers give that a meaning. */
export class UpstreamNotFound extends Error {
  constructor(readonly provider: string) {
    super(`Not found at ${provider}`);
  }
}

/** The provider answered 401 to a request that asked to hear it ({@link UpstreamRequest.unauthorizedIsRetryable}). */
export class UpstreamUnauthorized extends Error {
  constructor(readonly provider: string) {
    super(`Unauthorized at ${provider}`);
  }
}

/**
 * Calls a JSON API and maps its failures, once, onto the envelope every route
 * shares — NEAR Intents, Jupiter and Kuru Flow each had to say the same thing.
 * The client reads `service`, never `provider`, and a reason the provider
 * gave is relayed only once `scrubUpstreamText` has taken its names and links
 * out of it:
 *
 *   - **400 / 422**: the provider refused the request itself (an amount below
 *     its minimum, no route) — a 400 `provider_error` carrying its short
 *     reason, because it is something the caller can change;
 *   - **401 / 403**: our key was refused — `misconfigured`, the env var logged;
 *   - **404**: {@link UpstreamNotFound}, for the caller to interpret;
 *   - **429**: 503 `provider_unavailable`; **5xx**: 502 `provider_error`;
 *   - a timeout is a 504, a dead socket a 502, both `provider_unavailable`.
 *
 * A {@link UpstreamRequest.personalData} request keeps the timeout and socket
 * mapping, but every other failure is an {@link UpstreamStatusError} logged by
 * key names only.
 */
export async function requestUpstreamJson<T>(
  req: UpstreamRequest,
  logger: Logger,
): Promise<T> {
  const hasBody = req.body !== undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  const label = `${req.provider} ${req.method} ${new URL(req.url).pathname}`;
  try {
    const res = await fetch(req.url, {
      method: req.method,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'CosmosPay/1.0',
        ...req.headers,
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
      body: hasBody ? JSON.stringify(req.body) : undefined,
    });
    const text = await res.text();
    const payload = safeJsonParse(text);
    if (res.ok) return payload as T;

    if (req.personalData) {
      const code = errorCodeOf(payload);
      const keys = keysOf(payload);
      logger.warn(
        `${label} -> ${res.status}: ${code ?? 'no error code'} (keys: ${keys.join(', ') || 'none'})`,
      );
      throw new UpstreamStatusError(req.provider, res.status, code, keys, text);
    }

    const redact = req.redact ?? ((line: string) => line);
    const raw = upstreamMessage(payload);
    const message = raw === null ? null : redact(raw);
    logger.warn(
      `${label} -> ${res.status}: ${message ?? redact(text.slice(0, 200))}`,
    );
    throw statusError(req, res.status, message);
  } catch (err) {
    if (
      err instanceof HttpException ||
      err instanceof UpstreamNotFound ||
      err instanceof UpstreamUnauthorized ||
      err instanceof UpstreamStatusError
    ) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      logger.error(`${label} timed out`);
      throw new ApiError(
        HttpStatus.GATEWAY_TIMEOUT,
        ApiErrorCode.ProviderUnavailable,
        `${capitalize(req.service)} did not answer in time.`,
      );
    }
    logger.error(
      `${label} failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    throw ApiError.badGateway(
      ApiErrorCode.ProviderUnavailable,
      `Could not reach ${req.service}.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function statusError(
  req: UpstreamRequest,
  status: number,
  message: string | null,
): Error {
  if (status === 404) return new UpstreamNotFound(req.provider);
  if (status === 401 && req.unauthorizedIsRetryable) {
    return new UpstreamUnauthorized(req.provider);
  }
  if (status === 400 || status === 422) {
    return ApiError.badRequest(
      ApiErrorCode.ProviderError,
      message
        ? `${capitalize(req.service)} refused the request: ${message}`
        : `${capitalize(req.service)} refused the request.`,
    );
  }
  if (status === 401 || status === 403) {
    return ApiError.misconfigured(
      `${capitalize(req.service)} rejected this deployment’s credentials.`,
      `${req.provider} answered ${status}: check ${req.keyEnv}`,
    );
  }
  if (status === 429) {
    return ApiError.unavailable(
      ApiErrorCode.ProviderUnavailable,
      `${capitalize(req.service)} is rate limiting this service. Retry shortly.`,
    );
  }
  return ApiError.badGateway(
    ApiErrorCode.ProviderError,
    `${capitalize(req.service)} returned an error. Retry shortly.`,
  );
}

function safeJsonParse(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The provider's own error code (`errorCode`, else `code`) when it is a plain upper-case word. */
function errorCodeOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const code = [obj.errorCode, obj.code].find(
    (v): v is string => typeof v === 'string' && ERROR_CODE_RE.test(v),
  );
  return code ?? null;
}

/** The top-level key names of a JSON object body (at most 20, each a plain word), else none. */
function keysOf(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }
  return Object.keys(payload)
    .filter((key) => /^[A-Za-z0-9_$-]{1,64}$/.test(key))
    .slice(0, 20);
}

/** The provider's own reason (`message`, else `error`), one line, bounded, scrubbed of its names. */
function upstreamMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const raw = [obj.message, obj.error].find(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  if (!raw) return null;
  const line = scrubUpstreamText(raw.replace(/\s+/g, ' ').trim());
  if (!line) return null;
  return line.length > MAX_MESSAGE_LENGTH
    ? `${line.slice(0, MAX_MESSAGE_LENGTH)}…`
    : line;
}
