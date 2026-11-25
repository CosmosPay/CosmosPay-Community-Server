import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '@/common/errors/api-error';
import {
  requestUpstreamJson,
  UpstreamNotFound,
  UpstreamUnauthorized,
} from '@/common/upstream-http';
import type {
  AppConfig,
  KoyweEnvironmentConfig,
  StellarNetwork,
} from '@/config/configuration';
import {
  isKoyweEnvironmentComplete,
  prefixOf,
} from '@/native-plugins/koywe/koywe-config';
import {
  BANK_TRANSFER_SERVICE,
  KOYWE_PROVIDER,
  KOYWE_TIMEOUT_MS,
  KOYWE_TOKEN_TTL_MS,
} from '@/native-plugins/koywe/koywe.constants';

/** `POST /quotes` as a conversion asks it. */
export interface OnrampQuoteRequest {
  orderType: 'ONRAMP';
  executable: true;
  originCurrencySymbol: 'ARS';
  destinationCurrencySymbol: string;
  amountIn: number;
  network: string;
}

/** `POST /orders` for an ONRAMP on a quote. */
export interface OnrampOrderRequest {
  type: 'ONRAMP';
  quoteId: string;
  destinationAccountId: string;
  externalId: string;
  description: string;
}

/** `POST /accounts` for a seller's wallet (the fields the spec requires). */
export interface CryptoAccountRequest {
  name: string;
  kind: 'CRYPTO';
  address: string;
  accountNumber: string;
  routingNumber: '';
  isDefault: false;
  network: string;
  currencySymbol: string;
}

/** `POST /merchants`: a seller's merchant under Cosmos Pay's organization. */
export interface CreateMerchantRequest {
  countryId: string;
  profile: {
    name: string;
    address: string;
    city?: string;
    postalCode?: string;
    taxIdType: string;
    taxIdNumber: string;
    slug: string;
    supportEmail: string;
    email: string;
    phone?: string;
    dateOfBirth?: string;
    nationalityCountrySymbol?: string;
  };
}

/** `POST /onboarding/kyb`. */
export interface TriggerKybRequest {
  forceRetrigger?: boolean;
  contactOverride?: { email?: string; language: string };
}

/** The fields this plugin reads of the provider's answers; everything is checked before use. */
export type KoyweRecord = Record<string, unknown>;

/**
 * The provider's API as this plugin uses it: the one place that builds its
 * URLs, holds its credentials and turns its failures into this service's
 * errors (through `requestUpstreamJson`, under {@link BANK_TRANSFER_SERVICE}).
 *
 * Two environments, one per network: production (`KOYWE_*`) for `public`,
 * the sandbox (`KOYWE_SANDBOX_*`) for `testnet`. Each signs in with its key and
 * secret for a bearer token (about an hour), kept in memory and renewed early;
 * a 401 on a call drops it, signs in once more and retries that call once.
 * Every merchant-scoped call names the merchant: a seller's own, or Cosmos
 * Pay's in pooled mode.
 */
@Injectable()
export class KoyweClient {
  private readonly logger = new Logger(KoyweClient.name);
  private readonly tokens = new Map<
    StellarNetwork,
    { token: string; at: number }
  >();
  private readonly signingIn = new Map<StellarNetwork, Promise<string>>();

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /** Whether `network`'s environment can be called at all. */
  isConfigured(network: StellarNetwork): boolean {
    return isKoyweEnvironmentComplete(this.environment(network));
  }

  /** The organization's id on `network` (webhook envelopes name it). */
  organizationId(network: StellarNetwork): string {
    return this.environment(network).organizationId;
  }

  get timeoutMs(): number {
    return KOYWE_TIMEOUT_MS;
  }

  /** Every country the provider knows (a merchant is created with its id). */
  countries(network: StellarNetwork): Promise<unknown> {
    return this.call(network, 'GET', '/api/v1/countries');
  }

  createMerchant(
    network: StellarNetwork,
    body: CreateMerchantRequest,
  ): Promise<KoyweRecord> {
    return this.call(network, 'POST', `${this.org(network)}/merchants`, body);
  }

  triggerKyb(
    network: StellarNetwork,
    merchantId: string,
    body: TriggerKybRequest,
  ): Promise<KoyweRecord> {
    return this.call(
      network,
      'POST',
      `${this.merchant(network, merchantId)}/onboarding/kyb`,
      body,
    );
  }

  kyb(
    network: StellarNetwork,
    merchantId: string,
    kybId: string,
  ): Promise<KoyweRecord> {
    return this.call(
      network,
      'GET',
      `${this.merchant(network, merchantId)}/onboarding/kyb/${encodeURIComponent(kybId)}`,
    );
  }

  /** The merchant's virtual accounts (one per currency). */
  virtualAccounts(
    network: StellarNetwork,
    merchantId: string,
  ): Promise<unknown> {
    return this.call(
      network,
      'GET',
      `${this.merchant(network, merchantId)}/virtual-accounts`,
    );
  }

  /** The merchant's ARS virtual account (a CVU), created once. */
  createArsVirtualAccount(
    network: StellarNetwork,
    merchantId: string,
  ): Promise<KoyweRecord> {
    return this.call(
      network,
      'POST',
      `${this.merchant(network, merchantId)}/virtual-accounts`,
      { country: 'AR', currency: 'ARS' },
    );
  }

  /** The merchant's CRYPTO accounts for a token on a network, at an address. */
  searchCryptoAccounts(
    network: StellarNetwork,
    merchantId: string,
    query: { currencySymbol: string; network: string; address: string },
  ): Promise<unknown> {
    const params = new URLSearchParams({ kind: 'CRYPTO', ...query });
    return this.call(
      network,
      'GET',
      `${this.merchant(network, merchantId)}/accounts/search?${params.toString()}`,
    );
  }

  createCryptoAccount(
    network: StellarNetwork,
    merchantId: string,
    body: CryptoAccountRequest,
  ): Promise<KoyweRecord> {
    return this.call(
      network,
      'POST',
      `${this.merchant(network, merchantId)}/accounts`,
      body,
    );
  }

  quote(
    network: StellarNetwork,
    merchantId: string,
    body: OnrampQuoteRequest,
  ): Promise<KoyweRecord> {
    return this.call(
      network,
      'POST',
      `${this.merchant(network, merchantId)}/quotes`,
      body,
    );
  }

  /** An order; `externalId` makes it idempotent per merchant and type. */
  createOrder(
    network: StellarNetwork,
    merchantId: string,
    body: OnrampOrderRequest,
  ): Promise<KoyweRecord> {
    return this.call(
      network,
      'POST',
      `${this.merchant(network, merchantId)}/orders`,
      body,
    );
  }

  order(
    network: StellarNetwork,
    merchantId: string,
    orderId: string,
  ): Promise<KoyweRecord> {
    return this.call(
      network,
      'GET',
      `${this.merchant(network, merchantId)}/orders/${encodeURIComponent(orderId)}`,
    );
  }

  /** The order made with `externalId`, or null when there is none. */
  async orderByExternalId(
    network: StellarNetwork,
    merchantId: string,
    externalId: string,
  ): Promise<KoyweRecord | null> {
    try {
      return await this.call<KoyweRecord>(
        network,
        'GET',
        `${this.merchant(network, merchantId)}/orders/external/${encodeURIComponent(externalId)}`,
      );
    } catch (error) {
      if (error instanceof UpstreamNotFound) return null;
      throw error;
    }
  }

  /** Sandbox only: a deposit to the merchant's ARS account, which fires `bank_income.received`. */
  simulateBankIncome(
    merchantId: string,
    body: {
      currency: 'ARS';
      amount: number;
      documentType: string;
      documentNumber: string;
      customerReference?: string;
    },
  ): Promise<KoyweRecord> {
    return this.call(
      'testnet',
      'POST',
      `${this.merchant('testnet', merchantId)}/sandbox/bank-income/simulate`,
      body,
    );
  }

  /** The organization's webhook endpoints. */
  webhookEndpoints(network: StellarNetwork): Promise<unknown> {
    return this.call(network, 'GET', `${this.org(network)}/webhooks`);
  }

  /** Registers `url`, signed with the environment's webhook secret. */
  createWebhookEndpoint(
    network: StellarNetwork,
    url: string,
    name: string,
  ): Promise<KoyweRecord> {
    return this.call(network, 'POST', `${this.org(network)}/webhooks`, {
      url,
      name,
      secret: this.environment(network).webhookSecret,
    });
  }

  pingWebhookEndpoint(
    network: StellarNetwork,
    webhookId: string,
  ): Promise<KoyweRecord> {
    return this.call(
      network,
      'POST',
      `${this.org(network)}/webhooks/${encodeURIComponent(webhookId)}/ping`,
      {},
    );
  }

  private environment(network: StellarNetwork): KoyweEnvironmentConfig {
    return this.config.get('koywe', { infer: true }).environments[network];
  }

  private org(network: StellarNetwork): string {
    return `/api/v1/organizations/${encodeURIComponent(this.organizationId(network))}`;
  }

  private merchant(network: StellarNetwork, merchantId: string): string {
    return `${this.org(network)}/merchants/${encodeURIComponent(merchantId)}`;
  }

  /**
   * One call with the environment's token; a 401 drops the token, signs in
   * again and retries once (a second 401 is the credentials: `misconfigured`).
   */
  private async call<T>(
    network: StellarNetwork,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const environment = this.ready(network);
    try {
      return await this.request<T>(network, environment, method, path, body, {
        token: await this.token(network, environment),
        retryable: true,
      });
    } catch (error) {
      if (!(error instanceof UpstreamUnauthorized)) throw error;
      this.tokens.delete(network);
      this.logger.warn(
        `${KOYWE_PROVIDER} (${network}) refused the token: signing in again`,
      );
      return this.request<T>(network, environment, method, path, body, {
        token: await this.token(network, environment),
        retryable: false,
      });
    }
  }

  private request<T>(
    network: StellarNetwork,
    environment: KoyweEnvironmentConfig,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    auth: { token: string; retryable: boolean },
  ): Promise<T> {
    return requestUpstreamJson<T>(
      {
        provider: KOYWE_PROVIDER,
        service: BANK_TRANSFER_SERVICE,
        keyEnv: `${prefixOf(network)}API_KEY`,
        method,
        url: `${environment.apiUrl}${path}`,
        headers: { authorization: `Bearer ${auth.token}` },
        ...(body === undefined ? {} : { body }),
        timeoutMs: KOYWE_TIMEOUT_MS,
        unauthorizedIsRetryable: auth.retryable,
        redact: redactDigits,
      },
      this.logger,
    );
  }

  /** The environment's bearer token: the one on hand while young enough, else a sign-in (one at a time). */
  private token(
    network: StellarNetwork,
    environment: KoyweEnvironmentConfig,
  ): Promise<string> {
    const cached = this.tokens.get(network);
    if (cached && Date.now() - cached.at < KOYWE_TOKEN_TTL_MS) {
      return Promise.resolve(cached.token);
    }
    const running = this.signingIn.get(network);
    if (running) return running;
    const signIn = requestUpstreamJson<{ token?: unknown }>(
      {
        provider: KOYWE_PROVIDER,
        service: BANK_TRANSFER_SERVICE,
        keyEnv: `${prefixOf(network)}API_KEY`,
        method: 'POST',
        url: `${environment.apiUrl}/api/v1/auth/sign-in`,
        body: { apiKey: environment.apiKey, secret: environment.secret },
        timeoutMs: KOYWE_TIMEOUT_MS,
        redact: redactDigits,
      },
      this.logger,
    )
      .then((answer) => {
        if (typeof answer?.token !== 'string' || answer.token === '') {
          throw ApiError.misconfigured(
            'Bank transfers are not available on this deployment.',
            `${KOYWE_PROVIDER} (${network}) signed in without a token`,
          );
        }
        this.tokens.set(network, { token: answer.token, at: Date.now() });
        return answer.token;
      })
      .finally(() => this.signingIn.delete(network));
    this.signingIn.set(network, signIn);
    return signIn;
  }

  /** The environment, refused as `misconfigured` before any call when it is incomplete. */
  private ready(network: StellarNetwork): KoyweEnvironmentConfig {
    const environment = this.environment(network);
    if (!isKoyweEnvironmentComplete(environment)) {
      throw ApiError.misconfigured(
        'Bank transfers are not available on this deployment.',
        `${prefixOf(network)}API_KEY, SECRET, ORGANIZATION_ID and WEBHOOK_SECRET must all be set`,
      );
    }
    return environment;
  }
}

/**
 * The provider's error text with every run of seven or more digits masked: an
 * error about a merchant or a deposit may echo the tax id or document it was
 * sent, which this service never logs or relays.
 */
export function redactDigits(text: string): string {
  return text.replace(/\d[\d.\- ]{5,}\d/g, (run) =>
    run.replace(/\D/g, '').length >= 7 ? '[redacted]' : run,
  );
}
