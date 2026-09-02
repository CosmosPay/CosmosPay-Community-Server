import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig, StellarNetwork } from '@/config/configuration';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  POLLAR_API_KEY_HEADER,
  POLLAR_SDK_API_VERSION,
  POLLAR_SERVER_API_VERSION,
} from '@/pollar/pollar.constants';

type QueryValue = string | number | boolean | undefined | null;

/**
 * Every Pollar response is wrapped: `{ content, code, success: true }` on the
 * way out, `{ code, success: false, message? }` on failure, with the HTTP status
 * carrying the status. `code` is the stable part — `WALLET_ALREADY_FUNDED`,
 * `SDK_AUTH_TOKEN_EXPIRED` — so it is what we branch on and what we relay.
 */
interface PollarEnvelope<T> {
  success?: boolean;
  code?: string;
  content?: T;
  message?: string;
  resultCode?: string;
}

export interface PollarRequestOptions {
  body?: unknown;
  query?: Record<string, QueryValue>;
  /** End-user access token, for the routes that act as a logged-in user. */
  accessToken?: string;
  /** Overrides the per-call budget (the session wait polls on a short leash). */
  timeoutMs?: number;
}

/** A Pollar failure that reached us with its own code, kept for branching. */
export class PollarApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PollarApiError';
  }
}

/**
 * Thin authenticated HTTP client for Pollar's two APIs.
 *
 * They are separate surfaces with separate credentials and Pollar refuses a key
 * used on the wrong one, so {@link sdk} and {@link server} are separate methods
 * rather than a base-URL argument — the call site cannot pick the wrong key.
 *
 *   - **SDK API** (`/v2`, publishable key): the hosted OAuth redirect, the
 *     client session, `/auth/login`, `/auth/refresh`, `/auth/logout`.
 *   - **Server API** (`/v1`, secret key): activate a wallet, trustlines,
 *     register a user, verify a token.
 *
 * Both are network-scoped: the key prefix names the network, so the caller
 * passes the network it resolved from the API key's environment and gets the
 * matching pair.
 *
 * The client holds no Stellar key and never sees one — Pollar custodies the
 * user's key in its own KMS, and this service only ever passes tokens through.
 */
@Injectable()
export class PollarClient {
  private readonly logger = new Logger(PollarClient.name);
  private readonly cfg: AppConfig['pollar'];

  constructor(config: ConfigService<AppConfig, true>) {
    this.cfg = config.get('pollar', { infer: true });
  }

  /** The publishable key for `network` — it travels in the OAuth URL, and is public. */
  publishableKey(network: StellarNetwork): string {
    return this.requireKey(
      this.cfg.publishableKey[network],
      network,
      'publishable',
    );
  }

  /** The callback URL Pollar returns the browser to, with the handshake state appended. */
  callbackUrl(state: string): string {
    if (!this.cfg.bridgeCallbackUrl) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'Pollar is not configured: set POLLAR_BRIDGE_CALLBACK_URL.',
      );
    }
    return `${this.cfg.bridgeCallbackUrl}/${encodeURIComponent(state)}`;
  }

  /** Base URL of the SDK API, version included. Used to build the OAuth URL. */
  sdkBase(): string {
    return `${this.cfg.sdkBaseUrl}/${POLLAR_SDK_API_VERSION}`;
  }

  /** A call to the SDK API, authenticated with the publishable key. */
  sdk<T>(
    method: string,
    network: StellarNetwork,
    path: string,
    opts: PollarRequestOptions = {},
  ): Promise<T> {
    return this.request<T>(
      method,
      `${this.sdkBase()}${path}`,
      this.publishableKey(network),
      opts,
    );
  }

  /** A call to the Server API, authenticated with the secret key. */
  server<T>(
    method: string,
    network: StellarNetwork,
    path: string,
    opts: PollarRequestOptions = {},
  ): Promise<T> {
    const base = `${this.cfg.serverBaseUrl}/${POLLAR_SERVER_API_VERSION}`;
    return this.request<T>(
      method,
      `${base}${path}`,
      this.requireKey(this.cfg.secretKey[network], network, 'secret'),
      opts,
    );
  }

  /**
   * One request. Returns the envelope's `content`, or throws:
   * {@link PollarApiError} when Pollar answered with its own code (so a caller
   * can branch on e.g. `WALLET_ALREADY_FUNDED`), and an {@link ApiError} for a
   * transport failure or timeout.
   */
  private async request<T>(
    method: string,
    url: string,
    apiKey: string,
    opts: PollarRequestOptions,
  ): Promise<T> {
    const target = withQuery(url, opts.query);
    const hasBody = opts.body !== undefined;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? this.cfg.timeoutMs,
    );

    try {
      const res = await fetch(target, {
        method,
        signal: controller.signal,
        headers: {
          [POLLAR_API_KEY_HEADER]: apiKey,
          accept: 'application/json',
          'user-agent': 'CosmosPay/1.0',
          // Pollar mints DPoP-bound tokens only when a JWK is supplied at login.
          // Without one the token is a plain bearer, which is what a token the
          // bridge passes through has to be.
          ...(opts.accessToken
            ? { authorization: `Bearer ${opts.accessToken}` }
            : {}),
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(opts.body) : undefined,
      });
      return await this.parse<T>(res, method, url);
    } catch (err) {
      throw this.toException(err, method, url);
    } finally {
      clearTimeout(timer);
    }
  }

  private async parse<T>(
    res: Response,
    method: string,
    url: string,
  ): Promise<T> {
    const text = await res.text();
    const envelope = (
      text ? safeJsonParse(text) : null
    ) as PollarEnvelope<T> | null;

    if (!res.ok || envelope?.success === false) {
      const code = envelope?.code ?? `HTTP_${res.status}`;
      // The path is ours to debug; the body may echo the user's profile back,
      // so only Pollar's own short code and message are kept.
      this.logger.warn(
        `Pollar ${method} ${redactUrl(url)} -> ${res.status} ${code}`,
      );
      throw new PollarApiError(
        res.status,
        code,
        envelope?.message ?? `Pollar returned ${code}`,
      );
    }

    // A 2xx with no envelope is a contract drift, not a success: returning
    // `undefined` here would surface downstream as a missing token.
    if (!envelope || envelope.content === undefined) {
      this.logger.warn(
        `Pollar ${method} ${redactUrl(url)} -> ${res.status} with no content`,
      );
      throw ApiError.badGateway(
        ApiErrorCode.ProviderError,
        'Pollar returned an unexpected response.',
      );
    }

    return envelope.content;
  }

  private toException(err: unknown, method: string, url: string): Error {
    if (err instanceof PollarApiError || err instanceof HttpException) {
      return err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      this.logger.error(`Pollar ${method} ${redactUrl(url)} timed out`);
      return new ApiError(
        HttpStatus.GATEWAY_TIMEOUT,
        ApiErrorCode.ProviderUnavailable,
        'Pollar request timed out',
      );
    }
    const detail = err instanceof Error ? err.message : 'unknown error';
    this.logger.error(`Pollar ${method} ${redactUrl(url)} failed: ${detail}`);
    return ApiError.badGateway(
      ApiErrorCode.ProviderUnavailable,
      'Could not reach Pollar.',
    );
  }

  private requireKey(
    key: string,
    network: StellarNetwork,
    kind: 'publishable' | 'secret',
  ): string {
    if (!key) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        `Pollar is not configured for ${network}: set the ${kind} key for this network.`,
      );
    }
    return key;
  }
}

function withQuery(url: string, query?: Record<string, QueryValue>): string {
  if (!query) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      parsed.searchParams.set(key, String(value));
    }
  }
  return parsed.toString();
}

/**
 * Drops the query string before a URL is logged. The OAuth URL carries
 * `api_key` and `client_session_id`, neither of which belongs in stdout.
 */
function redactUrl(url: string): string {
  const cut = url.indexOf('?');
  return cut === -1 ? url : `${url.slice(0, cut)}?…`;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
