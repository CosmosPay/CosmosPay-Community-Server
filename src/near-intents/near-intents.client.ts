import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@/config/configuration';
import { requestUpstreamJson, UpstreamNotFound } from '@/common/upstream-http';
import { NEAR_INTENTS_TOKENS_TTL_MS } from '@/near-intents/near-intents.constants';
import type {
  NearIntentsDepositSubmission,
  NearIntentsQuoteRequest,
  NearIntentsQuoteResponse,
  NearIntentsStatusResponse,
  NearIntentsToken,
} from '@/near-intents/near-intents.types';

/**
 * The one way this service reaches NEAR Intents: an HTTP client for the 1Click
 * API. Feature code never builds a 1Click URL. Failures map onto the shared
 * envelope in `requestUpstreamJson`.
 *
 * It never holds a key that moves money: 1Click derives the deposit address and
 * its solvers pay the destination. The partner key only identifies us.
 */
@Injectable()
export class NearIntentsClient {
  private readonly logger = new Logger(NearIntentsClient.name);
  private tokensCache?: { at: number; tokens: Promise<NearIntentsToken[]> };

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /**
   * Every token 1Click can swap, cached for {@link NEAR_INTENTS_TOKENS_TTL_MS}.
   * A failed fetch is not cached: the next call tries again.
   */
  tokens(): Promise<NearIntentsToken[]> {
    const now = Date.now();
    if (
      this.tokensCache &&
      now - this.tokensCache.at < NEAR_INTENTS_TOKENS_TTL_MS
    ) {
      return this.tokensCache.tokens;
    }
    const tokens = this.request<NearIntentsToken[]>('GET', '/v0/tokens');
    const entry = { at: now, tokens };
    this.tokensCache = entry;
    tokens.catch(() => {
      if (this.tokensCache === entry) this.tokensCache = undefined;
    });
    return tokens;
  }

  /** A quote — dry (a price) or live (a price and a deposit address). */
  quote(body: NearIntentsQuoteRequest): Promise<NearIntentsQuoteResponse> {
    return this.request<NearIntentsQuoteResponse>('POST', '/v0/quote', body);
  }

  /**
   * Where a swap stands, by its deposit address (and memo, on Stellar). Null
   * when 1Click does not know the address — never the case for one it issued,
   * so the caller treats it as "ask again later", not as a failure.
   */
  async status(
    depositAddress: string,
    depositMemo?: string | null,
  ): Promise<NearIntentsStatusResponse | null> {
    const query = new URLSearchParams({ depositAddress });
    if (depositMemo) query.set('depositMemo', depositMemo);
    try {
      return await this.request<NearIntentsStatusResponse>(
        'GET',
        `/v0/status?${query.toString()}`,
      );
    } catch (err) {
      if (err instanceof UpstreamNotFound) return null;
      throw err;
    }
  }

  /**
   * Tells 1Click which transaction paid a deposit address. Optional to the
   * protocol — 1Click watches the address anyway — but it starts the swap
   * without waiting for its indexer.
   */
  submitDeposit(
    body: NearIntentsDepositSubmission,
  ): Promise<NearIntentsStatusResponse> {
    return this.request<NearIntentsStatusResponse>(
      'POST',
      '/v0/deposit/submit',
      body,
    );
  }

  private request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const { baseUrl, apiKey, timeoutMs } = this.config.get('nearIntents', {
      infer: true,
    });
    return requestUpstreamJson<T>(
      {
        provider: 'NEAR Intents',
        keyEnv: 'NEAR_INTENTS_API_KEY',
        method,
        url: `${baseUrl}${path}`,
        headers: apiKey ? { 'x-api-key': apiKey } : undefined,
        body,
        timeoutMs,
      },
      this.logger,
    );
  }
}
