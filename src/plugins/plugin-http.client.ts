import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { PluginViolationError } from '@/plugins/plugin-errors';
import {
  PLUGIN_HTTP_FORBIDDEN_HEADERS,
  PLUGIN_HTTP_MAX_REQUEST_BYTES,
  PLUGIN_HTTP_MAX_RESPONSE_BYTES,
  PLUGIN_HTTP_METHODS,
  PLUGIN_HTTP_TIMEOUT_MS,
} from '@/plugins/plugins.constants';
import {
  PluginError,
  type PluginHttp,
  type PluginHttpRequest,
  type PluginHttpResponse,
  type PluginJson,
} from '@/plugins/sdk';
import { pinnedLookup } from '@/webhooks/webhook-http';
import {
  assertPublicWebhookUrl,
  DEFAULT_DNS_LOOKUP,
  type DnsLookupFn,
  type ValidatedWebhookDestination,
  WebhookUrlValidationError,
} from '@/webhooks/webhook-url.validator';

/** One outbound request, after every check has passed. */
export interface PluginHttpSend {
  url: URL;
  destination: ValidatedWebhookDestination;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * Outbound HTTP for plugins — `ctx.http`.
 *
 * A plugin reaches the network through here or not at all, and here only
 * reaches:
 *
 *   - `https:`, on port 443, with no credentials in the URL;
 *   - a host its manifest lists in `egress`, matched exactly;
 *   - a PUBLIC address: the webhook destination rules apply (no loopback,
 *     private, link-local, metadata…), and the socket is pinned to the address
 *     that was checked, so a rebinding DNS answer cannot redirect it.
 *
 * Redirects are not followed — a 3xx comes back as a 3xx — because following
 * one is how an allowlisted host hands the request to a host that is not.
 */
@Injectable()
export class PluginHttpClient {
  private lookup: DnsLookupFn = DEFAULT_DNS_LOOKUP;

  /** Test seam: replace the DNS resolver. */
  replaceDnsLookup(lookup: DnsLookupFn): void {
    this.lookup = lookup;
  }

  /** The `ctx.http` a plugin with this egress list sees. */
  forPlugin(slug: string, egress: readonly string[]): PluginHttp {
    const allowed = new Set(egress);
    return {
      request: async (request) =>
        this.send(await this.prepare(slug, allowed, request)),
    };
  }

  private async prepare(
    slug: string,
    allowed: ReadonlySet<string>,
    request: PluginHttpRequest,
  ): Promise<PluginHttpSend> {
    const method = String(request?.method ?? '').toUpperCase();
    if (!PLUGIN_HTTP_METHODS.has(method)) {
      throw new PluginError(
        `http method must be one of ${[...PLUGIN_HTTP_METHODS].join(', ')}`,
      );
    }

    let url: URL;
    try {
      url = new URL(String(request.url));
    } catch {
      throw new PluginError('http url must be an absolute URL');
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')) {
      throw new PluginViolationError(
        `Plugin ${slug} tried to reach ${url.protocol}//${url.host}: only https on port 443 is allowed`,
      );
    }
    if (!allowed.has(host)) {
      throw new PluginViolationError(
        `Plugin ${slug} tried to reach ${host}, which is not in its egress list`,
      );
    }

    let destination: ValidatedWebhookDestination;
    try {
      destination = await assertPublicWebhookUrl(url.toString(), this.lookup);
    } catch (err) {
      if (err instanceof WebhookUrlValidationError) {
        throw new PluginViolationError(
          `Plugin ${slug} egress to ${host} refused: ${err.detail ?? err.message}`,
        );
      }
      throw err;
    }

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      const lower = name.toLowerCase();
      if (PLUGIN_HTTP_FORBIDDEN_HEADERS.has(lower)) {
        throw new PluginError(`http header "${name}" is set by the runtime`);
      }
      if (typeof value !== 'string' || /[\r\n]/.test(value + name)) {
        throw new PluginError(
          `http header "${name}" must be a single-line string`,
        );
      }
      headers[lower] = value;
    }

    let body: string | undefined;
    if (request.body !== undefined) {
      if (typeof request.body === 'string') {
        body = request.body;
      } else {
        body = JSON.stringify(request.body);
        headers['content-type'] ??= 'application/json';
      }
      if (Buffer.byteLength(body) > PLUGIN_HTTP_MAX_REQUEST_BYTES) {
        throw new PluginError(
          `http body must be at most ${PLUGIN_HTTP_MAX_REQUEST_BYTES} bytes`,
        );
      }
    }

    return { url, destination, method, headers, body };
  }

  /** The network half: a pinned `https.request`. Replaced in tests. */
  send(prepared: PluginHttpSend): Promise<PluginHttpResponse> {
    const { url, destination, method, headers, body } = prepared;
    return new Promise<PluginHttpResponse>((resolve, reject) => {
      const req = httpsRequest(
        {
          protocol: 'https:',
          host: destination.hostname,
          servername: destination.hostname,
          port: destination.port,
          path: `${url.pathname}${url.search}`,
          method,
          headers: {
            ...headers,
            ...(body !== undefined
              ? { 'content-length': String(Buffer.byteLength(body)) }
              : {}),
          },
          signal: AbortSignal.timeout(PLUGIN_HTTP_TIMEOUT_MS),
          lookup: pinnedLookup(destination),
          agent: false,
        },
        (res: IncomingMessage) => {
          readBody(res, PLUGIN_HTTP_MAX_RESPONSE_BYTES).then(
            (text) => resolve(toResponse(res, text)),
            reject,
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }
}

function toResponse(res: IncomingMessage, body: string): PluginHttpResponse {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(res.headers)) {
    if (value !== undefined) {
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return Object.freeze({
    status: res.statusCode ?? 0,
    headers: Object.freeze(headers),
    body,
    json: (): PluginJson => {
      try {
        return JSON.parse(body) as PluginJson;
      } catch {
        throw new PluginError('The response body is not JSON');
      }
    },
  });
}

function readBody(res: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    res.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        res.destroy();
        reject(
          new PluginViolationError(
            `Plugin egress response exceeded ${maxBytes} bytes`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}
