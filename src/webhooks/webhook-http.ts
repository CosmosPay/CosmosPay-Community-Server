import { Injectable } from '@nestjs/common';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import type { ValidatedWebhookDestination } from './webhook-url.validator';

/**
 * Shared outbound HTTP for webhook delivery.
 *
 * Every POST leaves through {@link postWebhook}, which connects to the address
 * the destination guard validated instead of resolving the hostname again.
 * `fetch` cannot do that: it runs its own DNS lookup, so the address that was
 * checked is never the address that is connected to, and a short-TTL record
 * alternating between a public IP and `169.254.169.254` passes validation and is
 * then POSTed — signed body and all — at the cloud metadata service, with the
 * response read back. Pinning the socket to the checked address is the fix, and
 * Node's `fetch` has no public dispatcher hook without the `undici` package,
 * which is not resolvable from this project. Hence `https.request` with a
 * pinned `lookup`.
 *
 * Certificate verification is untouched (`rejectUnauthorized` stays default) and
 * redirects are never followed — `https.request` does not follow them at all, so
 * a 3xx surfaces as a non-2xx status and the delivery fails loudly.
 */
export type WebhookHttpLimits = {
  connectTimeoutMs: number;
  readTimeoutMs: number;
  maxResponseBytes: number;
};

/** What the receiver answered. Body is drained and discarded, never parsed. */
export interface WebhookHttpResponse {
  status: number;
  ok: boolean;
}

export interface WebhookHttpRequest {
  /** The registered URL — supplies path and query; never the connect target. */
  url: string;
  destination: ValidatedWebhookDestination;
  headers: Record<string, string>;
  body: string;
  limits: WebhookHttpLimits;
}

/**
 * The injectable seam for outbound webhook HTTP.
 *
 * The transport is a provider rather than a bare import so a test can replace
 * the network without knowing how delivery is implemented — `overrideProvider`
 * at bootstrap, or a spy on the resolved instance:
 *
 *   jest.spyOn(app.get(WebhookHttpClient), 'send')
 *     .mockResolvedValue({ status: 200, ok: true });
 *
 * Stubbing the global `fetch` used to serve that purpose, and stopped working
 * the moment delivery had to pin its own socket. A seam that only holds while
 * the implementation stays on one particular global is not a seam.
 */
@Injectable()
export class WebhookHttpClient {
  send(request: WebhookHttpRequest): Promise<WebhookHttpResponse> {
    return postWebhook(request);
  }
}

/** Combined abort budget: connect phase + read phase. */
export function webhookAbortSignal(
  limits: Pick<WebhookHttpLimits, 'connectTimeoutMs' | 'readTimeoutMs'>,
): AbortSignal {
  return AbortSignal.timeout(limits.connectTimeoutMs + limits.readTimeoutMs);
}

/**
 * Backoff before retry `attemptIndex + 1`, spread over `[base/2, base]`.
 *
 * The delay used to be exactly `backoffMs * (attemptIndex + 1)` for everyone.
 * When a receiver comes back from an outage, every delivery that was waiting on
 * it retries in lockstep — the herd arrives together, knocks it over again, and
 * re-synchronizes on the next tier. Equal jitter keeps half the delay as a
 * guaranteed floor and randomizes the rest, which is enough to decorrelate the
 * senders without letting any retry come back sooner than half its tier.
 */
export function jitteredBackoffMs(
  backoffMs: number,
  attemptIndex: number,
  random: () => number = Math.random,
): number {
  const base = backoffMs * (attemptIndex + 1);
  return Math.round(base / 2 + random() * (base / 2));
}

/**
 * POSTs `body` to `url`, connecting to the pre-validated
 * {@link ValidatedWebhookDestination} rather than re-resolving the hostname.
 */
export function postWebhook({
  url,
  destination,
  headers,
  body,
  limits,
}: WebhookHttpRequest): Promise<WebhookHttpResponse> {
  const target = new URL(url);
  const signal = webhookAbortSignal(limits);

  return new Promise<WebhookHttpResponse>((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: 'https:',
        // `host` and `servername` stay the registered hostname, so the `Host`
        // header, the SNI extension and `checkServerIdentity` all still see the
        // name the certificate is issued for — virtual hosting and TLS keep
        // working exactly as they did under `fetch`.
        host: destination.hostname,
        servername: destination.hostname,
        port: destination.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          ...headers,
          'content-length': String(Buffer.byteLength(body)),
        },
        signal,
        // ...while the socket connects to the address that was validated.
        lookup: pinnedLookup(destination),
        // A pooled socket outlives the pin that opened it: keep-alive would let
        // a later request reuse a connection made for a different resolution,
        // with no check of its own. One throwaway agent per request instead.
        agent: false,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        drainBody(res, limits.maxResponseBytes).then(
          () => resolve({ status, ok: status >= 200 && status < 300 }),
          reject,
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * A `lookup` that answers with the already-validated address instead of asking
 * the resolver a second time. This is the whole point: validation and
 * connection now resolve once, together, so there is no window to rebind in.
 */
function pinnedLookup(
  destination: ValidatedWebhookDestination,
): LookupFunction {
  return (_hostname, options, callback) => {
    const { address, family } = destination;
    // Happy-eyeballs (`autoSelectFamily`) asks for every answer at once.
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

/** Drain the response body up to `maxBytes`, destroying the socket if exceeded. */
function drainBody(res: IncomingMessage, maxBytes: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let total = 0;
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err) {
        res.destroy();
        reject(err);
        return;
      }
      resolve();
    };

    res.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish(
          new Error(
            `Webhook response exceeded size limit of ${maxBytes} bytes`,
          ),
        );
      }
    });
    res.on('end', () => finish());
    // A connection dropped mid-body is not a delivery failure: we already have
    // the status, and the body is discarded either way.
    res.on('close', () => finish());
    res.on('error', (err: Error) => finish(err));
  });
}
