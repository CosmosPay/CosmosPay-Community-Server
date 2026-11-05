import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { requestUpstreamJson } from '@/common/upstream-http';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import {
  ELDORADO_HOSTS,
  P2P_MARKETPLACE,
} from '@/native-plugins/eldorado/eldorado.constants';
import type {
  IntegratorIds,
  RawCurrency,
  RawPaymentMethod,
  RawPriceSide,
} from '@/native-plugins/eldorado/p2p-market';

/** What `/quote/buy` answers (the fields this API passes on). */
export interface RawBuyQuote {
  quoteId?: unknown;
  amountIn?: unknown;
  amountOut?: unknown;
  minAmountOut?: unknown;
  exchangeRate?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
  fee?: { amountInToken?: unknown; amountInFiat?: unknown } | null;
}

/** The body `/quote/buy` takes. */
export interface BuyQuoteRequest {
  addressTo: string;
  token: string;
  chainId: string;
  fiatCurrencyId: string;
  paymentMethodId: string;
  amount: string;
  fixedAmountSide: 'IN';
}

/**
 * El Dorado's API, as this plugin uses it: the one place that builds its URLs,
 * holds the integrator ids and turns its failures into this service's errors
 * (through `requestUpstreamJson`, under the name {@link P2P_MARKETPLACE}).
 *
 * The market reads take no credentials. The buy quote requires the
 * `X-Client-ID` and `X-Referral-ID` El Dorado issues to an integrator: without
 * them it is `503 misconfigured` before any call.
 */
@Injectable()
export class EldoradoClient {
  private readonly logger = new Logger(EldoradoClient.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  currencies(network: StellarNetwork): Promise<{ currencies?: RawCurrency[] }> {
    return this.get(network, '/currencies');
  }

  paymentMethods(
    network: StellarNetwork,
  ): Promise<{ paymentMethods?: RawPaymentMethod[] }> {
    return this.get(network, '/payment-methods');
  }

  prices(network: StellarNetwork): Promise<{ BUY?: RawPriceSide }> {
    return this.get(network, '/prices');
  }

  /** A firm buy quote. Needs the integrator ids. */
  buyQuote(
    network: StellarNetwork,
    body: BuyQuoteRequest,
  ): Promise<RawBuyQuote> {
    const ids = this.integratorIds();
    if (!ids) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'Firm P2P quotes are not available on this deployment: the P2P marketplace integrator ids are not configured.',
      );
    }
    return requestUpstreamJson<RawBuyQuote>(
      {
        provider: P2P_MARKETPLACE,
        keyEnv: 'ELDORADO_CLIENT_ID',
        method: 'POST',
        url: `${ELDORADO_HOSTS[network].api}/quote/buy`,
        headers: {
          'X-Client-ID': ids.clientId,
          'X-Referral-ID': ids.referralId,
        },
        body,
        timeoutMs: this.timeoutMs,
      },
      this.logger,
    );
  }

  /** Both integrator ids, or null when either is missing. */
  integratorIds(): IntegratorIds | null {
    const cfg = this.config.get('eldorado', { infer: true });
    return cfg.clientId && cfg.referralId
      ? { clientId: cfg.clientId, referralId: cfg.referralId }
      : null;
  }

  private get timeoutMs(): number {
    return this.config.get('eldorado', { infer: true }).timeoutMs;
  }

  private get<T>(network: StellarNetwork, path: string): Promise<T> {
    return requestUpstreamJson<T>(
      {
        provider: P2P_MARKETPLACE,
        keyEnv: 'ELDORADO_CLIENT_ID',
        method: 'GET',
        url: `${ELDORADO_HOSTS[network].api}${path}`,
        timeoutMs: this.timeoutMs,
      },
      this.logger,
    );
  }
}
