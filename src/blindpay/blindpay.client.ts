import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';

type QueryValue = string | number | boolean | undefined | null;

export interface BlindpayRequestOptions {
  body?: unknown;
  query?: Record<string, QueryValue>;
}

/** A multipart file, as produced by Multer's memory storage. */
export interface UploadableFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/**
 * Thin authenticated HTTP client for the BlindPay REST API.
 *
 * We run a single platform instance: the API key and instance id come from env,
 * and most resources live under `/instances/{instanceId}/...` (use
 * {@link instancePath}). Non-2xx responses are surfaced as Nest HttpExceptions —
 * client errors (4xx) pass the upstream status through so callers see a faithful
 * reason, while upstream 5xx/timeouts become 502/504. The client never holds
 * blockchain keys: signing always happens on the customer's side.
 */
@Injectable()
export class BlindpayClient {
  private readonly logger = new Logger(BlindpayClient.name);
  private readonly cfg: AppConfig['blindpay'];

  constructor(config: ConfigService<AppConfig, true>) {
    this.cfg = config.get('blindpay', { infer: true });
  }

  /** The configured platform instance id (`in_...`). */
  get instanceId(): string {
    return this.cfg.instanceId;
  }

  /** Whether the integration has the credentials it needs to make calls. */
  get isConfigured(): boolean {
    return Boolean(this.cfg.apiKey && this.cfg.instanceId);
  }

  /** Builds an instance-scoped path: `/instances/{instanceId}{path}`. */
  instancePath(path: string): string {
    return `/instances/${this.cfg.instanceId}${path}`;
  }

  get<T>(path: string, opts: BlindpayRequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, opts);
  }

  post<T>(
    path: string,
    body?: unknown,
    opts: BlindpayRequestOptions = {},
  ): Promise<T> {
    return this.request<T>('POST', path, { ...opts, body });
  }

  put<T>(
    path: string,
    body?: unknown,
    opts: BlindpayRequestOptions = {},
  ): Promise<T> {
    return this.request<T>('PUT', path, { ...opts, body });
  }

  delete<T>(path: string, opts: BlindpayRequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, opts);
  }

  async request<T>(
    method: string,
    path: string,
    opts: BlindpayRequestOptions = {},
  ): Promise<T> {
    this.ensureConfigured();

    const url = this.buildUrl(path, opts.query);
    const hasBody = opts.body !== undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          accept: 'application/json',
          'user-agent': 'CosmosPay/1.0',
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(opts.body) : undefined,
      });
      return await this.parse<T>(res, method, path);
    } catch (err) {
      throw this.toException(err, method, path);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Uploads a KYC/compliance document. BlindPay's upload endpoint is not nested
   * under the instance path; the instance id travels as a query param and the
   * body is multipart form-data (let fetch set the boundary).
   */
  async uploadFile(
    file: UploadableFile,
    bucket: string,
  ): Promise<{ file_url: string }> {
    this.ensureConfigured();

    const form = new FormData();
    form.append('bucket', bucket);
    form.append(
      'file',
      // Copy into a fresh Uint8Array so the BlobPart is backed by a plain
      // ArrayBuffer (Node's Buffer can be backed by a SharedArrayBuffer).
      new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }),
      file.originalname,
    );

    const url = this.buildUrl('/upload', { instance_id: this.cfg.instanceId });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          accept: 'application/json',
          'user-agent': 'CosmosPay/1.0',
        },
        body: form,
      });
      return await this.parse<{ file_url: string }>(res, 'POST', '/upload');
    } catch (err) {
      throw this.toException(err, 'POST', '/upload');
    } finally {
      clearTimeout(timer);
    }
  }

  private async parse<T>(
    res: Response,
    method: string,
    path: string,
  ): Promise<T> {
    const text = await res.text();
    const payload: unknown = text ? safeJsonParse(text) : null;

    if (!res.ok) {
      this.logger.warn(
        `BlindPay ${method} ${path} -> ${res.status}: ${truncate(text)}`,
      );
      throw this.upstreamError(res.status, payload, text);
    }

    return payload as T;
  }

  /** Maps a non-2xx BlindPay response to an HttpException. */
  private upstreamError(
    status: number,
    payload: unknown,
    rawText: string,
  ): HttpException {
    const message =
      extractMessage(payload) ?? rawText ?? 'BlindPay request failed';

    // Pass client errors through with their original status so the caller learns
    // the real reason (validation, not-found, conflict, auth). Collapse upstream
    // server errors into a 502 — they are not the caller's fault.
    if (status >= 400 && status < 500) {
      return new HttpException(
        { statusCode: status, message, provider: 'blindpay' },
        status,
      );
    }
    return new BadGatewayException(`BlindPay upstream error: ${message}`);
  }

  private toException(
    err: unknown,
    method: string,
    path: string,
  ): HttpException {
    if (err instanceof HttpException) {
      return err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      this.logger.error(`BlindPay ${method} ${path} timed out`);
      return new GatewayTimeoutException('BlindPay request timed out');
    }
    const detail = err instanceof Error ? err.message : 'unknown error';
    this.logger.error(`BlindPay ${method} ${path} failed: ${detail}`);
    return new BadGatewayException(`Could not reach BlindPay: ${detail}`);
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.cfg.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private ensureConfigured(): void {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException(
        'BlindPay is not configured: set BLINDPAY_API_KEY and BLINDPAY_INSTANCE_ID.',
      );
    }
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractMessage(payload: unknown): string | null {
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const candidate = obj.message ?? obj.error ?? obj.detail;
    if (typeof candidate === 'string') {
      return candidate;
    }
    if (Array.isArray(candidate)) {
      return candidate.map((c) => String(c)).join('; ');
    }
  }
  return null;
}

function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
