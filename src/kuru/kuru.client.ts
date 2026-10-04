import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { requestUpstreamJson } from '@/common/upstream-http';
import type { AppConfig } from '@/config/configuration';
import {
  KURU_TOKEN_CACHE_MAX,
  KURU_TOKEN_REFRESH_MARGIN_S,
} from '@/kuru/kuru.constants';

/** The unsigned call a Kuru Flow quote comes with. */
export interface KuruTransaction {
  to: string;
  /** Hex calldata, with or without `0x`. */
  calldata: string;
  /** Wei, decimal string: the native MON sent along (zero for an ERC-20 sale). */
  value: string;
}

/** A successful `POST /api/quote`. */
export interface KuruQuote {
  /** Base units of `tokenOut`, net of the referrer fee. */
  output: string;
  /** The on-chain minimum after slippage. */
  minOut: string;
  transaction: KuruTransaction;
}

interface KuruQuoteAnswer extends Partial<KuruQuote> {
  status?: string;
  error?: string;
  message?: string;
}

/**
 * Kuru Flow — Monad's aggregator, which same-chain Monad swaps are routed
 * through. It prices and hands back an unsigned call; the wallet signs it and
 * this service broadcasts it through its own Monad RPC.
 *
 * Auth: `KURU_API_KEY` when set. Without it Kuru issues a JWT per user address
 * (`/api/generate-token`, one request a second each), cached here until just
 * before it expires — fine for trying it out, not for production volume.
 */
@Injectable()
export class KuruClient {
  private readonly logger = new Logger(KuruClient.name);
  private readonly tokens = new Map<string, { token: string; until: number }>();

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async quote(params: {
    userAddress: string;
    tokenIn: string;
    tokenOut: string;
    /** Base units of `tokenIn`. */
    amount: string;
    slippageBps: number;
    referrerAddress: string | null;
    referrerFeeBps: number;
  }): Promise<KuruQuote> {
    const answer = await this.request<KuruQuoteAnswer>(
      '/api/quote',
      {
        userAddress: params.userAddress,
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amount: params.amount,
        slippageTolerance: Math.max(params.slippageBps, 1),
        ...(params.referrerAddress && params.referrerFeeBps > 0
          ? {
              referrerAddress: params.referrerAddress,
              referrerFeeBps: params.referrerFeeBps,
            }
          : {}),
      },
      params.userAddress,
    );
    // Kuru answers a failed route search with a 200 and an error body.
    if (
      answer.status !== 'success' ||
      !answer.output ||
      !answer.minOut ||
      !answer.transaction?.to
    ) {
      throw ApiError.badRequest(
        ApiErrorCode.ProviderError,
        `Kuru Flow refused the request: ${
          answer.message ?? answer.error ?? 'no route for this pair and amount'
        }`,
      );
    }
    return {
      output: answer.output,
      minOut: answer.minOut,
      transaction: answer.transaction,
    };
  }

  private async request<T>(
    path: string,
    body: unknown,
    userAddress: string,
  ): Promise<T> {
    const { baseUrl, apiKey, timeoutMs } = this.config.get('swapAggregators', {
      infer: true,
    }).kuru;
    const auth: Record<string, string> = apiKey
      ? { 'x-api-key': apiKey }
      : { authorization: `Bearer ${await this.token(userAddress)}` };
    return requestUpstreamJson<T>(
      {
        provider: 'Kuru Flow',
        keyEnv: 'KURU_API_KEY',
        method: 'POST',
        url: `${baseUrl}${path}`,
        headers: auth,
        body,
        timeoutMs,
      },
      this.logger,
    );
  }

  /** A keyless JWT for `userAddress`, reused until shortly before it expires. */
  private async token(userAddress: string): Promise<string> {
    const key = userAddress.toLowerCase();
    const now = Math.floor(Date.now() / 1000);
    const cached = this.tokens.get(key);
    if (cached && cached.until > now) return cached.token;

    const { baseUrl, timeoutMs } = this.config.get('swapAggregators', {
      infer: true,
    }).kuru;
    const issued = await requestUpstreamJson<{
      token: string;
      expires_at: number;
    }>(
      {
        provider: 'Kuru Flow',
        keyEnv: 'KURU_API_KEY',
        method: 'POST',
        url: `${baseUrl}/api/generate-token`,
        body: { user_address: userAddress },
        timeoutMs,
      },
      this.logger,
    );
    // Bounded: one entry per address a quote was asked for. Dropping the
    // oldest only costs that address a token request.
    if (this.tokens.size >= KURU_TOKEN_CACHE_MAX) {
      const oldest = this.tokens.keys().next().value;
      if (oldest !== undefined) this.tokens.delete(oldest);
    }
    this.tokens.set(key, {
      token: issued.token,
      until: issued.expires_at - KURU_TOKEN_REFRESH_MARGIN_S,
    });
    return issued.token;
  }
}
