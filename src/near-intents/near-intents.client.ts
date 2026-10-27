import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@/config/configuration';
import { requestUpstreamJson, UpstreamNotFound } from '@/common/upstream-http';
import {
  NEAR_INTENTS_TOKENS_STALE_MS,
  NEAR_INTENTS_TOKENS_TTL_MS,
} from '@/near-intents/near-intents.constants';
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
export class NearIntentsClient implements OnApplicationBootstrap {
  private readonly logger = new Logger(NearIntentsClient.name);
  /** The last list 1Click answered, and when. A failed fetch never replaces it. */
  private tokensCache?: { at: number; tokens: NearIntentsToken[] };
  /** The one fetch in flight: concurrent callers and refreshes share it. */
  private tokensFetch?: Promise<NearIntentsToken[]>;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /**
   * Off the boot path, the first token list is fetched before any request needs it, so the
   * first dashboard read after a deploy does not wait for it. A 1Click that is down must not
   * keep the service from starting: the first caller then fetches it, as before.
   */
  onApplicationBootstrap(): void {
    if (!this.config.get('nearIntents', { infer: true }).prefetchTokens) return;
    void this.refreshTokens().catch((error: unknown) => {
      this.logger.warn(`token list prefetch skipped: ${String(error)}`);
    });
  }

  /**
   * Every token 1Click can swap. Fresh for {@link NEAR_INTENTS_TOKENS_TTL_MS}; past that and
   * up to {@link NEAR_INTENTS_TOKENS_STALE_MS} the list on hand is answered at once while one
   * background fetch replaces it (stale-while-revalidate), so no caller waits for a refresh.
   * Only a caller with no usable list waits for 1Click, and a failed fetch is not cached:
   * the next call tries again.
   */
  tokens(): Promise<NearIntentsToken[]> {
    const cached = this.tokensCache;
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && age < NEAR_INTENTS_TOKENS_TTL_MS) {
      return Promise.resolve(cached.tokens);
    }
    if (cached && age < NEAR_INTENTS_TOKENS_STALE_MS) {
      void this.refreshTokens().catch((error: unknown) => {
        this.logger.warn(
          `token list refresh failed; serving the one from ${Math.round(age / 1000)} s ago: ${String(error)}`,
        );
      });
      return Promise.resolve(cached.tokens);
    }
    return this.refreshTokens();
  }

  /** Fetches the list once, however many callers ask meanwhile, and keeps it if it arrives. */
  private refreshTokens(): Promise<NearIntentsToken[]> {
    this.tokensFetch ??= this.request<NearIntentsToken[]>('GET', '/v0/tokens')
      .then((tokens) => {
        this.tokensCache = { at: Date.now(), tokens };
        return tokens;
      })
      .finally(() => {
        this.tokensFetch = undefined;
      });
    return this.tokensFetch;
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
