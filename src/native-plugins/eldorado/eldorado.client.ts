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

/** What `/quote/buy` and `/quote/sell` answer (the fields this API passes on). */
export interface RawQuote {
  quoteId?: unknown;
  amountIn?: unknown;
  amountOut?: unknown;
  minAmountOut?: unknown;
  exchangeRate?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
  fee?: { amountInToken?: unknown; amountInFiat?: unknown } | null;
}

/** What both quote bodies share: the order, its token on `chainId`, the amount it puts in. */
interface QuoteRequestBase {
  token: string;
  chainId: string;
  fiatCurrencyId: string;
  paymentMethodId: string;
  amount: string;
  fixedAmountSide: 'IN';
}

/** The body `/quote/buy` takes: `addressTo` receives the stablecoin. */
export interface BuyQuoteRequest extends QuoteRequestBase {
  addressTo: string;
}

/** The body `/quote/sell` takes: `addressFrom` sends the stablecoin. */
export interface SellQuoteRequest extends QuoteRequestBase {
  addressFrom: string;
}

/**
 * El Dorado's API, as this plugin uses it: the one place that builds its URLs,
 * holds the integrator ids and turns its failures into this service's errors
 * (through `requestUpstreamJson`, under the name {@link P2P_MARKETPLACE}).
 *
 * The market reads take no credentials. Both quotes require the
 * `X-Client-ID` and `X-Referral-ID` El Dorado issues to an integrator: without
 * them they are `503 misconfigured` before any call.
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

  prices(
    network: StellarNetwork,
  ): Promise<{ BUY?: RawPriceSide; SELL?: RawPriceSide }> {
    return this.get(network, '/prices');
  }

  /** A firm buy quote. Needs the integrator ids. */
  buyQuote(network: StellarNetwork, body: BuyQuoteRequest): Promise<RawQuote> {
    return this.quote(network, '/quote/buy', body);
  }

  /** A firm sell quote. Needs the integrator ids. */
  sellQuote(
    network: StellarNetwork,
    body: SellQuoteRequest,
  ): Promise<RawQuote> {
    return this.quote(network, '/quote/sell', body);
  }

  /** Both integrator ids, or null when either is missing. */
  integratorIds(): IntegratorIds | null {
    const cfg = this.config.get('eldorado', { infer: true });
    return cfg.clientId && cfg.referralId
      ? { clientId: cfg.clientId, referralId: cfg.referralId }
      : null;
  }

  private quote(
    network: StellarNetwork,
    path: '/quote/buy' | '/quote/sell',
    body: BuyQuoteRequest | SellQuoteRequest,
  ): Promise<RawQuote> {
    const ids = this.integratorIds();
    if (!ids) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'Firm P2P quotes are not available on this deployment: the P2P marketplace integrator ids are not configured.',
      );
    }
    return requestUpstreamJson<RawQuote>(
      {
        provider: P2P_MARKETPLACE,
        keyEnv: 'ELDORADO_CLIENT_ID',
        method: 'POST',
        url: `${ELDORADO_HOSTS[network].api}${path}`,
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
