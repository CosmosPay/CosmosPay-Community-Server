import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';

/** The longest upstream message relayed to a caller; anything longer is cut. */
const MAX_MESSAGE_LENGTH = 300;

/** One JSON call to a third-party HTTP API. */
export interface UpstreamRequest {
  /** How errors name the provider ("NEAR Intents", "Jupiter", "Kuru Flow"). */
  provider: string;
  /** The env var holding its key, named when that key is refused. */
  keyEnv: string;
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

/** The provider answered 404. Only some callers give that a meaning. */
export class UpstreamNotFound extends Error {
  constructor(readonly provider: string) {
    super(`Not found at ${provider}`);
  }
}

/**
 * Calls a JSON API and maps its failures, once, onto the envelope every route
 * shares — NEAR Intents, Jupiter and Kuru Flow each had to say the same thing:
 *
 *   - **400 / 422**: the provider refused the request itself (an amount below
 *     its minimum, no route) — a 400 `provider_error` carrying its short
 *     reason, because it is something the caller can change;
 *   - **401 / 403**: our key was refused — `misconfigured`, naming the env var;
 *   - **404**: {@link UpstreamNotFound}, for the caller to interpret;
 *   - **429**: 503 `provider_unavailable`; **5xx**: 502 `provider_error`;
 *   - a timeout is a 504, a dead socket a 502, both `provider_unavailable`.
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

    const message = upstreamMessage(payload);
    logger.warn(`${label} -> ${res.status}: ${message ?? text.slice(0, 200)}`);
    throw statusError(req, res.status, message);
  } catch (err) {
    if (err instanceof HttpException || err instanceof UpstreamNotFound) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      logger.error(`${label} timed out`);
      throw new ApiError(
        HttpStatus.GATEWAY_TIMEOUT,
        ApiErrorCode.ProviderUnavailable,
        `${req.provider} did not answer in time.`,
      );
    }
    logger.error(
      `${label} failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    throw ApiError.badGateway(
      ApiErrorCode.ProviderUnavailable,
      `Could not reach ${req.provider}.`,
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
  if (status === 400 || status === 422) {
    return ApiError.badRequest(
      ApiErrorCode.ProviderError,
      message
        ? `${req.provider} refused the request: ${message}`
        : `${req.provider} refused the request.`,
    );
  }
  if (status === 401 || status === 403) {
    return ApiError.unavailable(
      ApiErrorCode.Misconfigured,
      `${req.provider} rejected this deployment’s credentials: check ${req.keyEnv}.`,
    );
  }
  if (status === 429) {
    return ApiError.unavailable(
      ApiErrorCode.ProviderUnavailable,
      `${req.provider} is rate limiting this service. Retry shortly.`,
    );
  }
  return ApiError.badGateway(
    ApiErrorCode.ProviderError,
    `${req.provider} returned an error. Retry shortly.`,
  );
}

function safeJsonParse(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/** The provider's own reason (`message`, else `error`), one line, bounded. */
function upstreamMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const raw = [obj.message, obj.error].find(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  if (!raw) return null;
  const line = raw.replace(/\s+/g, ' ').trim();
  return line.length > MAX_MESSAGE_LENGTH
    ? `${line.slice(0, MAX_MESSAGE_LENGTH)}…`
    : line;
}
