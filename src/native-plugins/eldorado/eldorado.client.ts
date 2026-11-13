import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { requestUpstreamJson } from '@/common/upstream-http';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import {
  ELDORADO_HOSTS,
  P2P_DIRECT_PAYMENT_METHOD,
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

/** The languages `/auth/login/send-otp` writes its email in. */
export type DirectLoginLanguage = 'es' | 'en' | 'pt';

/** What `/auth/login/send-otp` answers (read defensively by the caller). */
export interface RawLoginChallenge {
  ok?: unknown;
  otpIdentifier?: unknown;
  action?: unknown;
}

/** What `/auth/login/verify-otp` answers. Its `user` is never read: it is the payer's profile. */
export interface RawLoginSession {
  ok?: unknown;
  token?: unknown;
  expiresAt?: unknown;
}

/** The L1 data `POST /kyc` takes: the country (always AR here), the city and the phone. */
export interface KycDetailsValues {
  countryOfResidence: string;
  cityOfResidence: string;
  phoneNumber: string;
}

/** The body `/orders/buy` takes: a quote, the payer's bank account (new or saved) and the delivery. */
export interface BuyOrderRequest {
  quoteId: string;
  fiatDetails: { details: Record<string, string> } | { detailsId: string };
  cryptoDetails: {
    recipientAddress: string;
    tokenAddress: string;
    chainId: string;
  };
  externalReferenceId: string;
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

  // --- the direct flow: a payer's own marketplace session ------------------
  //
  // Every call below sends the deployment's client id with the API referral
  // id (`ELDORADO_API_REFERRAL_ID`, source type API: the payer never opens
  // the widget), and every one but the login the payer's bearer token. Each
  // carries the payer's data one way or the other (their email, their bank
  // account, their token), so each is `personalData`: a failure is logged by
  // key names only and thrown as an `UpstreamStatusError` for the direct flow
  // to map onto its own codes. Without both ids, a 503 `p2p_unavailable`.

  /** Emails the payer a sign-in code (it also opens an account for a new email). */
  sendLoginCode(
    network: StellarNetwork,
    email: string,
    language: DirectLoginLanguage,
  ): Promise<RawLoginChallenge> {
    return this.direct(network, 'POST', '/auth/login/send-otp', null, {
      email,
      language,
    });
  }

  /** Trades the emailed code for the payer's bearer token; `username` only when a new account demands one. */
  verifyLoginCode(
    network: StellarNetwork,
    body: { otp: string; otpIdentifier: string; username?: string },
  ): Promise<RawLoginSession> {
    return this.direct(network, 'POST', '/auth/login/verify-otp', null, body);
  }

  /** The payer's verification level and what it needs next. */
  kyc(network: StellarNetwork, token: string): Promise<{ kyc?: unknown }> {
    return this.direct(network, 'GET', '/kyc', token);
  }

  /** Sends the L1 data (the marketplace then texts a code to the phone). */
  submitKycDetails(
    network: StellarNetwork,
    token: string,
    values: KycDetailsValues,
  ): Promise<{ ok?: unknown }> {
    return this.direct(network, 'POST', '/kyc', token, {
      data: { level: 'L1', values },
    });
  }

  /** Verifies the phone with the texted 4-digit code. */
  verifyKycPhone(
    network: StellarNetwork,
    token: string,
    code: string,
  ): Promise<{ ok?: unknown }> {
    return this.direct(network, 'POST', '/kyc/phone', token, { code });
  }

  /** The payer's profile and allowance: only `allowance` is read. */
  userInfo(
    network: StellarNetwork,
    token: string,
  ): Promise<{ allowance?: unknown }> {
    return this.direct(network, 'GET', '/user-info', token);
  }

  /** The payer's saved bank accounts for ARS bank transfers. */
  paymentDetails(
    network: StellarNetwork,
    token: string,
  ): Promise<{ paymentDetails?: unknown }> {
    return this.direct(
      network,
      'GET',
      `/payment-details?paymentMethodId=${P2P_DIRECT_PAYMENT_METHOD}`,
      token,
    );
  }

  /** A firm buy quote for the payer, under the API referral id. */
  directBuyQuote(
    network: StellarNetwork,
    token: string,
    body: BuyQuoteRequest,
  ): Promise<RawQuote> {
    return this.direct(network, 'POST', '/quote/buy', token, body);
  }

  /** Opens a buy order from a quote. */
  createBuyOrder(
    network: StellarNetwork,
    token: string,
    body: BuyOrderRequest,
  ): Promise<{ order?: unknown }> {
    return this.direct(network, 'POST', '/orders/buy', token, body);
  }

  /** One of the payer's orders. */
  order(
    network: StellarNetwork,
    token: string,
    orderId: string,
  ): Promise<{ order?: unknown }> {
    return this.direct(network, 'GET', orderPath(orderId), token);
  }

  /** Advances the payer's order from ACCEPTED to FIAT_PAID: they say they transferred. */
  markOrderPaid(
    network: StellarNetwork,
    token: string,
    orderId: string,
  ): Promise<{ order?: unknown }> {
    return this.direct(network, 'POST', orderPath(orderId), token);
  }

  /** Cancels the payer's order (only before they pay it). */
  cancelOrder(
    network: StellarNetwork,
    token: string,
    orderId: string,
  ): Promise<{ ok?: unknown }> {
    return this.direct(network, 'POST', `${orderPath(orderId)}/cancel`, token);
  }

  /** The ids the direct flow carries: the client id with the API referral id, or null without both. */
  directIds(): IntegratorIds | null {
    const cfg = this.config.get('eldorado', { infer: true });
    return cfg.clientId && cfg.apiReferralId
      ? { clientId: cfg.clientId, referralId: cfg.apiReferralId }
      : null;
  }

  private direct<T>(
    network: StellarNetwork,
    method: 'GET' | 'POST',
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<T> {
    const ids = this.directIds();
    if (!ids) {
      throw ApiError.unavailable(
        ApiErrorCode.P2pUnavailable,
        'Paying through a verified seller is not available right now: retry shortly or pay with another method.',
      );
    }
    return requestUpstreamJson<T>(
      {
        provider: P2P_MARKETPLACE,
        service: 'the P2P marketplace',
        keyEnv: 'ELDORADO_API_REFERRAL_ID',
        method,
        url: `${ELDORADO_HOSTS[network].api}${path}`,
        headers: {
          'X-Client-ID': ids.clientId,
          'X-Referral-ID': ids.referralId,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body,
        timeoutMs: this.timeoutMs,
        personalData: true,
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

/**
 * `/orders/{id}`, the id escaped: it comes from the payer's page. A dot-only
 * id would be a path segment the URL resolves (`..`), so it is escaped too.
 */
function orderPath(orderId: string): string {
  const escaped = encodeURIComponent(orderId).replace(/\./g, '%2E');
  return `/orders/${escaped}`;
}
