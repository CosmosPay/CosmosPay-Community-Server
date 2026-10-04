import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { requestUpstreamJson } from '@/common/upstream-http';
import type { AppConfig } from '@/config/configuration';

/** One hop of a Jupiter route. */
export interface JupiterRouteStep {
  swapInfo: { label?: string; inputMint: string; outputMint: string };
  percent?: number;
}

/**
 * `GET /quote`. Kept whole: `POST /swap` takes the quote back verbatim, so
 * nothing here may reshape it.
 */
export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  /** Net of the platform fee. */
  outAmount: string;
  /** The minimum out after slippage, for an ExactIn swap. */
  otherAmountThreshold: string;
  slippageBps: number;
  platformFee: { amount: string; feeBps: number } | null;
  routePlan: JupiterRouteStep[];
  [key: string]: unknown;
}

/** `POST /swap`. */
export interface JupiterSwapTransaction {
  /** base64 wire bytes of an unsigned VersionedTransaction. */
  swapTransaction: string;
  lastValidBlockHeight: number;
  simulationError?: { error?: string; errorCode?: string } | null;
}

/**
 * Jupiter's Swap API — the Solana aggregator same-chain Solana swaps are
 * routed through. It only prices and builds: the transaction comes back
 * unsigned, the wallet signs it, and this service broadcasts it through its own
 * Solana RPC. Jupiter never holds a key that moves money.
 */
@Injectable()
export class JupiterClient {
  private readonly logger = new Logger(JupiterClient.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  quote(params: {
    inputMint: string;
    outputMint: string;
    /** Base units of the input mint. */
    amount: string;
    slippageBps: number;
    platformFeeBps: number;
  }): Promise<JupiterQuote> {
    const query = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps: String(params.slippageBps),
      swapMode: 'ExactIn',
    });
    if (params.platformFeeBps > 0) {
      query.set('platformFeeBps', String(params.platformFeeBps));
    }
    return this.request<JupiterQuote>('GET', `/quote?${query.toString()}`);
  }

  /**
   * Builds the transaction for `quote`, paid and signed by `userPublicKey`.
   * Jupiter simulates it; a transaction that would fail on-chain (an empty
   * wallet, a stale route) is refused here instead of handed to a wallet to
   * sign and burn a fee on.
   */
  async swapTransaction(params: {
    quote: JupiterQuote;
    userPublicKey: string;
    /** Our token account for the fee mint, when a fee is charged. */
    feeAccount: string | null;
  }): Promise<JupiterSwapTransaction> {
    const built = await this.request<JupiterSwapTransaction>('POST', '/swap', {
      quoteResponse: params.quote,
      userPublicKey: params.userPublicKey,
      ...(params.feeAccount ? { feeAccount: params.feeAccount } : {}),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    });
    if (built.simulationError) {
      const reason =
        built.simulationError.error ?? built.simulationError.errorCode;
      throw ApiError.badRequest(
        ApiErrorCode.ProviderError,
        `Jupiter simulated the swap and it would fail on-chain${
          reason ? `: ${reason}` : ''
        }. Check the source wallet holds the amount plus SOL for fees.`,
      );
    }
    return built;
  }

  private request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const { baseUrl, apiKey, timeoutMs } = this.config.get('swapAggregators', {
      infer: true,
    }).jupiter;
    return requestUpstreamJson<T>(
      {
        provider: 'Jupiter',
        keyEnv: 'JUPITER_API_KEY',
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
