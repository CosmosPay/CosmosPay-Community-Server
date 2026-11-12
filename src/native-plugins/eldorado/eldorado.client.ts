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
  RawToken,
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

/** What both quote bodies share: the order, its token (by address) on `chainId`, the amount it puts in. */
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
 * The market reads (the chain and token lists included) take no credentials.
 * Both quotes require the
 * `X-Client-ID` and `X-Referral-ID` El Dorado issues to an integrator:
 * without them they are `503 misconfigured` before any call. The shared
 * public key carries `ELDORADO_PUBLIC_REFERRAL_ID` instead when it is set
 * (El Dorado prices the integrator's commission per referral id).
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

  /** The chains the marketplace trades on, as EIP-155 ids (strings). */
  chains(network: StellarNetwork): Promise<{ chains?: unknown }> {
    return this.get(network, '/chains');
  }

  /** One chain's tokens: thousands on mainnet's larger chains (Ethereum's is about 1.2 MB). */
  tokens(
    network: StellarNetwork,
    chainId: number,
  ): Promise<{ tokens?: RawToken[] }> {
    return this.get(network, `/chains/${chainId}/tokens`);
  }

  /**
   * The JWKS one network's marketplace signs its order webhooks with
   * (`ELDORADO_WEBHOOK_JWKS_URL_MAINNET` / `_TESTNET`, its API's
   * `/.well-known/jwks.json` by default). Takes no credentials.
   */
  webhookKeys(network: StellarNetwork): Promise<{ keys?: unknown }> {
    return requestUpstreamJson<{ keys?: unknown }>(
      {
        provider: P2P_MARKETPLACE,
        service: 'the P2P marketplace',
        keyEnv: 'ELDORADO_CLIENT_ID',
        method: 'GET',
        url: this.config.get('eldorado', { infer: true }).webhookJwksUrls[
          network
        ],
        timeoutMs: this.timeoutMs,
      },
      this.logger,
    );
  }

  /** A firm buy quote. Needs the integrator ids. */
  buyQuote(
    network: StellarNetwork,
    body: BuyQuoteRequest,
    sharedPublicKey: boolean,
  ): Promise<RawQuote> {
    return this.quote(network, '/quote/buy', body, sharedPublicKey);
  }

  /** A firm sell quote. Needs the integrator ids. */
  sellQuote(
    network: StellarNetwork,
    body: SellQuoteRequest,
    sharedPublicKey: boolean,
  ): Promise<RawQuote> {
    return this.quote(network, '/quote/sell', body, sharedPublicKey);
  }

  /**
   * Both integrator ids, or null when either is missing. For the shared public
   * key the referral id is `ELDORADO_PUBLIC_REFERRAL_ID` when it is set: the
   * one El Dorado prices anonymous use with.
   */
  integratorIds(sharedPublicKey: boolean): IntegratorIds | null {
    const cfg = this.config.get('eldorado', { infer: true });
    const referralId =
      sharedPublicKey && cfg.publicReferralId
        ? cfg.publicReferralId
        : cfg.referralId;
    return cfg.clientId && referralId
      ? { clientId: cfg.clientId, referralId }
      : null;
  }

  private quote(
    network: StellarNetwork,
    path: '/quote/buy' | '/quote/sell',
    body: BuyQuoteRequest | SellQuoteRequest,
    sharedPublicKey: boolean,
  ): Promise<RawQuote> {
    const ids = this.integratorIds(sharedPublicKey);
    if (!ids) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        'Firm P2P quotes are not available on this deployment: the P2P marketplace integrator ids are not configured.',
      );
    }
    return requestUpstreamJson<RawQuote>(
      {
        provider: P2P_MARKETPLACE,
        service: 'the P2P marketplace',
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
        service: 'the P2P marketplace',
        keyEnv: 'ELDORADO_CLIENT_ID',
        method: 'GET',
        url: `${ELDORADO_HOSTS[network].api}${path}`,
        timeoutMs: this.timeoutMs,
      },
      this.logger,
    );
  }
}
