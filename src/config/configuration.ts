import {
  DEFAULT_DEFINDEX_BASE_URL,
  DEFAULT_DEFINDEX_TIMEOUT_MS,
  DEFAULT_HORIZON,
  DEFAULT_RATE_LIMIT_PRUNE_INTERVAL_MS,
  DEFAULT_RECOVERY_SWEEP_INTERVAL_MS,
  DEFAULT_RECOVERY_TIMEOUT_MS,
  DEFAULT_WALLET_AUTH_SWEEP_INTERVAL_MS,
  DEFAULT_WALLET_AUTH_TIMEOUT_MS,
  NETWORK_PASSPHRASE_PUBLIC,
} from '@/config/config.constants';
import { parseReturnUrls } from '@/common/return-url';
import {
  parseRedirectUrlWhitelist,
  type RedirectUrlWhitelist,
} from '@/config/kyc-redirect-url-whitelist';

/**
 * Centralized, typed configuration loaded from environment variables.
 * Consumed via Nest's ConfigService<AppConfig, true>.
 */
export type StellarNetwork = 'public' | 'testnet';

/** The API-key environment a BlindPay instance serves (`dev` keys, `prod` keys). */
export type BlindpayEnvironment = 'dev' | 'prod';

/** Credentials of one BlindPay platform instance. */
export interface BlindpayInstanceConfig {
  apiKey: string;
  instanceId: string;
  // Svix endpoint secret (whsec_...) used to verify this instance's webhooks.
  webhookSecret: string;
}

export interface AppConfig {
  nodeEnv: string;
  /** When true, mounts /docs (Express middleware — not behind Nest guards). */
  swaggerEnabled: boolean;
  openapi: {
    /**
     * Gateway base URL stamped into the spec's `servers` — the root URL, since
     * paths already carry `/v1`. Empty adds no server entry.
     */
    serverUrl: string;
  };
  port: number;
  databaseUrl: string;
  apisix: {
    gatewaySecret: string;
    gatewaySecretHeader: string;
    consumerHeader: string;
    credentialHeader: string;
    environmentHeader: string;
    roleHeader: string;
    permissionsHeader: string;
    // Organization the API key belongs to, and the org's plan + plan-derived swap
    // commission. APISIX injects these per consumer (the dev platform sets them
    // from the org's plan); the client cannot supply them. This is how the swap
    // fee is enforced per organization and can never be passed as a request param.
    organizationHeader: string;
    planHeader: string;
    swapFeeBpsHeader: string;
    /** Verified email of the account that owns the key, as the gateway forwards it. */
    emailHeader: string;
    /**
     * Username of the SHARED public consumer — the one credential embedded in
     * every copy of the open-source wallet. Empty when the deployment publishes
     * no public key.
     *
     * PublicKeyGuard matches on this as well as on the forwarded role, so that a
     * gateway which stops sending `X-Consumer-Role` cannot silently promote every
     * anonymous caller to an ordinary tenant with read access to what the whole
     * anonymous population wrote.
     */
    publicConsumer: string;
  };
  kyc: {
    /**
     * Per-consumer redirect_url host allow-list (issue #33).
     * Empty map ⇒ every consumer fails closed until configured.
     */
    redirectUrlWhitelist: RedirectUrlWhitelist;
  };
  stellar: {
    // Fallback network when the API key environment is not forwarded
    // (e.g. local dev without the gateway). Otherwise the key type decides.
    network: StellarNetwork;
    horizon: Record<StellarNetwork, string>;
    baseFee: string;
    timeoutSeconds: number;
    swap: {
      // Platform account that collects the swap fee. When unset the fee is
      // disabled (no fee operation is added regardless of feeBps).
      feeWallet: string;
      // Swap fee in basis points (50 = 0.5%) taken from the source asset.
      feeBps: number;
      // Default slippage tolerance (bps) applied to the quote to derive destMin.
      slippageBps: number;
      // Hard cap on caller-supplied slippage, to bound how much they can lose.
      maxSlippageBps: number;
      /**
       * When true, reject create if the same (consumer, source, network) already
       * has a non-expired PENDING swap (409). Off by default — concurrent
       * distinct swaps from one account are legitimate; prefer Idempotency-Key.
       */
      singleInflight: boolean;
    };
  };
  observer: {
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
  };
  requestLogRetention: {
    // Days to keep RequestLog rows. 0 disables the prune job entirely.
    retentionDays: number;
    // How often the prune cycle runs.
    pruneIntervalMs: number;
    // Rows deleted per deleteMany (keeps each lock short).
    batchSize: number;
    // Hard cap on total rows deleted in one tick (catch-up without unbounded work).
    maxPerCycle: number;
    // Days to keep the *body* of a settled webhook delivery. 0 disables.
    deliveryPayloadDays: number;
    // Days to keep client-reported activity events. 0 disables that prune.
    activityEventDays: number;
  };
  webhookSweep: {
    // Recovers deliveries stranded by a crash mid-retry. Off disables the timer
    // entirely, so an operator can stop redelivery during an incident without a
    // redeploy — and the test bootstrap can keep it out of a test run.
    enabled: boolean;
    intervalMs: number;
  };
  paymentIntents: {
    // Lifetime of a payment intent; unpaid intents past this are marked EXPIRED.
    ttlSeconds: number;
  };
  webhooks: {
    // Overall AbortController budget ≈ connect + read (defense in depth).
    timeoutMs: number;
    connectTimeoutMs: number;
    readTimeoutMs: number;
    maxResponseBytes: number;
    maxAttempts: number;
    backoffMs: number;
    signatureHeader: string;
  };
  blindpay: {
    // BlindPay is the fiat<->stablecoin rails provider powering onramp/offramp/KYC.
    // One platform instance per API-key environment, each shared by every consumer
    // of that environment, with each receiver/payin/payout attributed internally
    // to the APISIX consumer that created it. A `dev` key reaching the production
    // instance could delete real KYC identities and move real money, so the
    // environment picks the instance the way it picks the Stellar network.
    baseUrl: string;
    timeoutMs: number;
    instances: Record<BlindpayEnvironment, BlindpayInstanceConfig>;
  };
  defindex: {
    apiKey: string;
    baseUrl: string;
    timeoutMs: number;
  };
  plugins: {
    /**
     * Slugs of the plugins in `plugins/` this deployment serves. A plugin that
     * is not listed is not even read: its routes answer 404 and its event
     * handlers never run. Empty — the default — serves none.
     */
    enabled: string[];
    /**
     * Key the secret half of every installation's config is sealed under.
     * Required at boot when an enabled plugin declares a secret field.
     */
    secret: string;
    /**
     * `<keyId>:<base64url Ed25519 public key>`, comma-separated: the signers
     * whose bundles this deployment runs. Parsed by the bundle loader.
     */
    trustedKeys: string;
    /** Load bundles with no signature. Refused when NODE_ENV=production. */
    allowUnsigned: boolean;
  };
  rateLimit: {
    /**
     * Master switch for `@RateLimit`. On by default — the routes it guards spend
     * XLM, so leaving them uncapped is not a default anyone should get by
     * omission. `false` is the incident switch, and it also keeps the prune
     * timer out of a test run.
     */
    enabled: boolean;
    /** How often rolled-over counter windows are deleted. */
    pruneIntervalMs: number;
  };
  walletAuth: {
    /**
     * The public origin a BROWSER reaches this service on — the gateway's, not
     * the upstream's. The OAuth redirect URI is built from it, and a provider
     * refuses a redirect URI it does not hold verbatim, so a wrong value fails
     * at the consent screen rather than quietly here.
     */
    publicBaseUrl: string;
    /**
     * Seals the session token a finished sign-in hands the wallet. Its OWN
     * secret, required at boot whenever a door is configured
     * (`identity-env.ts`). It used to fall back to the gateway secret, which the
     * developer platform also holds — so the platform could mint a session that
     * creates an account here.
     */
    sessionSecret: string;
    /**
     * Base URL of the operator console that performs the two legs this service
     * deliberately does not: sending the login-code email, and minting the
     * account's gateway credentials (which needs APISIX admin).
     *
     * Unset means this deployment has no email door and cannot finish a
     * sign-in — reported as such by `GET /v1/wallet/auth/providers` rather than
     * discovered at the end of a flow. A self-hosted deployment points it at its
     * own sender and owes this service nothing else.
     */
    consoleUrl: string;
    /** Proves a call to the console came from this service. Its own secret. */
    consoleSecret: string;
    /** Per-provider OAuth credentials. An empty pair disables that provider. */
    google: { clientId: string; clientSecret: string };
    github: { clientId: string; clientSecret: string };
    /**
     * The operator's OpenID Connect provider — Authentik. The preferred door:
     * its ID token is verified against the provider's published keys, and the
     * provider (not this service) owns passwords, MFA and the Google/GitHub
     * sources. Empty strings disable it.
     */
    oidc: { issuer: string; clientId: string; clientSecret: string };
    /**
     * The app URLs a provider callback may send the browser back to, for a
     * native wallet whose auth session (`ASWebAuthenticationSession`, a Custom
     * Tab, a desktop app's deep link or loopback listener) only closes when the
     * browser reaches a URL the app owns. Exact match; a loopback entry matches
     * any port. Empty means every callback renders the page instead.
     */
    returnUrls: string[];
    /**
     * The Horizon that says who may sign for an account, for a RECOVERED wallet
     * whose key is no longer its address. One, chosen by the operator — never by
     * the request, which would let a caller pick the ledger its signer is read
     * from.
     */
    signersHorizonUrl: string;
    /**
     * Pays the reserve of an account's two recovery signers
     * (`POST /v1/wallet/recovery/setup`). Unset disables the route. Refused at
     * boot on a recovery server.
     */
    sponsor: {
      secret: string;
      networkPassphrase: string;
      horizonUrl: string;
    };
    /** How long a call out to a provider may take before it is a failure. */
    timeoutMs: number;
    sweep: {
      enabled: boolean;
      intervalMs: number;
    };
  };
  /**
   * SEP-10 + SEP-30: this deployment as ONE of the two recovery servers.
   * `role: null` means it is not one, and every recovery route answers 404.
   */
  recovery: {
    role: 'a' | 'b' | null;
    /** The https origin plus gateway entry clients reach this server on. */
    publicBaseUrl: string;
    /** The WALLET's domain, named by every challenge — the same on both servers. */
    homeDomain: string;
    networkPassphrase: string;
    horizonUrl: string;
    signerMaster: string;
    sep10SigningSecret: string;
    jwtSecret: string;
    /** ID tokens this server exchanges for an identity; empty issuer disables it. */
    oidc: { issuer: string; audiences: string[] };
    /** Where this server posts its own emailed codes; empty url disables them. */
    emailDelivery: { url: string; secret: string };
    timeoutMs: number;
    sweep: {
      enabled: boolean;
      intervalMs: number;
    };
  };
}

function parseSwaggerEnabled(): boolean {
  const raw = process.env.SWAGGER_ENABLED;
  if (raw !== undefined) {
    return raw.toLowerCase() === 'true';
  }
  return (process.env.NODE_ENV ?? 'development') !== 'production';
}

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  swaggerEnabled: parseSwaggerEnabled(),
  openapi: {
    serverUrl: process.env.OPENAPI_SERVER_URL ?? '',
  },
  port: parseInt(process.env.PORT ?? '3000', 10),
  databaseUrl: process.env.DATABASE_URL ?? '',
  apisix: {
    gatewaySecret: process.env.APISIX_GATEWAY_SECRET ?? '',
    gatewaySecretHeader: (
      process.env.APISIX_GATEWAY_SECRET_HEADER ?? 'x-gateway-secret'
    ).toLowerCase(),
    consumerHeader: (
      process.env.APISIX_CONSUMER_HEADER ?? 'x-consumer-username'
    ).toLowerCase(),
    credentialHeader: (
      process.env.APISIX_CREDENTIAL_HEADER ?? 'x-credential-identifier'
    ).toLowerCase(),
    environmentHeader: (
      process.env.APISIX_ENVIRONMENT_HEADER ?? 'x-consumer-env'
    ).toLowerCase(),
    roleHeader: (
      process.env.APISIX_ROLE_HEADER ?? 'x-consumer-role'
    ).toLowerCase(),
    permissionsHeader: (
      process.env.APISIX_PERMISSIONS_HEADER ?? 'x-consumer-permissions'
    ).toLowerCase(),
    organizationHeader: (
      process.env.APISIX_ORGANIZATION_HEADER ?? 'x-consumer-org'
    ).toLowerCase(),
    planHeader: (
      process.env.APISIX_PLAN_HEADER ?? 'x-consumer-plan'
    ).toLowerCase(),
    swapFeeBpsHeader: (
      process.env.APISIX_SWAP_FEE_BPS_HEADER ?? 'x-plan-swap-fee-bps'
    ).toLowerCase(),
    emailHeader: (
      process.env.APISIX_EMAIL_HEADER ?? 'x-consumer-email'
    ).toLowerCase(),
    publicConsumer: (process.env.APISIX_PUBLIC_CONSUMER ?? '').trim(),
  },
  kyc: {
    redirectUrlWhitelist: parseRedirectUrlWhitelist(
      process.env.KYC_REDIRECT_URL_WHITELIST,
    ),
  },
  stellar: {
    network:
      (process.env.STELLAR_NETWORK ?? 'testnet').toLowerCase() === 'public'
        ? 'public'
        : 'testnet',
    horizon: {
      public: process.env.STELLAR_HORIZON_URL_PUBLIC ?? DEFAULT_HORIZON.public,
      testnet:
        process.env.STELLAR_HORIZON_URL_TESTNET ?? DEFAULT_HORIZON.testnet,
    },
    baseFee: process.env.STELLAR_BASE_FEE ?? '100',
    timeoutSeconds: parseInt(process.env.STELLAR_TX_TIMEOUT ?? '300', 10),
    swap: {
      feeWallet: process.env.STELLAR_SWAP_FEE_WALLET ?? '',
      feeBps: parseInt(process.env.STELLAR_SWAP_FEE_BPS ?? '50', 10),
      slippageBps: parseInt(process.env.STELLAR_SWAP_SLIPPAGE_BPS ?? '50', 10),
      maxSlippageBps: parseInt(
        process.env.STELLAR_SWAP_MAX_SLIPPAGE_BPS ?? '500',
        10,
      ),
      singleInflight:
        (process.env.STELLAR_SWAP_SINGLE_INFLIGHT ?? 'false').toLowerCase() ===
        'true',
    },
  },
  observer: {
    // Permanent reconciler that watches Stellar and finalizes paid intents.
    enabled: (process.env.OBSERVER_ENABLED ?? 'true').toLowerCase() !== 'false',
    intervalMs: parseInt(process.env.OBSERVER_INTERVAL_MS ?? '15000', 10),
    batchSize: parseInt(process.env.OBSERVER_BATCH_SIZE ?? '50', 10),
  },
  requestLogRetention: {
    // Append-only API access log (ip / userAgent). Pruned so PII is not kept forever.
    retentionDays: parseInt(process.env.REQUEST_LOG_RETENTION_DAYS ?? '30', 10),
    pruneIntervalMs: parseInt(
      process.env.REQUEST_LOG_PRUNE_INTERVAL_MS ?? '3600000',
      10,
    ),
    // Each deleteMany is capped so locks stay short; the tick loops until the
    // backlog is drained or maxPerCycle is hit (catches up after long outages).
    batchSize: parseInt(process.env.REQUEST_LOG_PRUNE_BATCH_SIZE ?? '1000', 10),
    maxPerCycle: parseInt(
      process.env.REQUEST_LOG_PRUNE_MAX_PER_CYCLE ?? '50000',
      10,
    ),
    // A delivery body is the event as sent, and a RECEIVER_UPDATED body is the
    // provider's full KYC dossier — tax id, address, document links. The row
    // itself is the audit trail and is kept; only the body is cleared, and only
    // once the delivery has reached a terminal state and is well past any
    // redelivery window. Default 30 days; 0 keeps bodies forever (the old
    // behaviour) for an operator who needs that and accepts the exposure.
    deliveryPayloadDays: parseInt(
      process.env.WEBHOOK_PAYLOAD_RETENTION_DAYS ?? '30',
      10,
    ),
    // Client telemetry (`activity_event`). A row carries an IP, a user agent
    // and whatever the client put in `props`, so it is personal data on the
    // same footing as the access log and gets the same default window. 0 keeps
    // events forever, which is a deliberate choice an operator has to make.
    activityEventDays: parseInt(
      process.env.ACTIVITY_RETENTION_DAYS ?? '30',
      10,
    ),
  },
  webhookSweep: {
    // Default on: a stranded delivery is a customer-visible settlement that
    // notified nobody, so recovery is not opt-in. `false` is the incident
    // switch (and how the test bootstrap keeps the timer out of a test run).
    enabled:
      (process.env.WEBHOOK_SWEEP_ENABLED ?? 'true').toLowerCase() !== 'false',
    intervalMs: parseInt(process.env.WEBHOOK_SWEEP_INTERVAL_MS ?? '60000', 10),
  },
  paymentIntents: {
    ttlSeconds: parseInt(process.env.PAYMENT_INTENT_TTL_SECONDS ?? '3600', 10),
  },
  webhooks: {
    // Legacy single timeout kept for callers that still read timeoutMs;
    // prefer connectTimeoutMs + readTimeoutMs for outbound delivery.
    timeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS ?? '5000', 10),
    connectTimeoutMs: parseInt(
      process.env.WEBHOOK_CONNECT_TIMEOUT_MS ??
        process.env.WEBHOOK_TIMEOUT_MS ??
        '3000',
      10,
    ),
    readTimeoutMs: parseInt(
      process.env.WEBHOOK_READ_TIMEOUT_MS ??
        process.env.WEBHOOK_TIMEOUT_MS ??
        '5000',
      10,
    ),
    maxResponseBytes: parseInt(
      process.env.WEBHOOK_MAX_RESPONSE_BYTES ?? '65536',
      10,
    ),
    maxAttempts: parseInt(process.env.WEBHOOK_MAX_ATTEMPTS ?? '3', 10),
    backoffMs: parseInt(process.env.WEBHOOK_BACKOFF_MS ?? '2000', 10),
    signatureHeader: (
      process.env.WEBHOOK_SIGNATURE_HEADER ?? 'x-cosmos-signature'
    ).toLowerCase(),
  },
  blindpay: {
    baseUrl: (
      process.env.BLINDPAY_BASE_URL ?? 'https://api.blindpay.com/v1'
    ).replace(/\/+$/, ''),
    timeoutMs: parseInt(process.env.BLINDPAY_TIMEOUT_MS ?? '15000', 10),
    instances: {
      // The unsuffixed variables stay the production instance, so a deployment
      // that configured BlindPay before the split keeps serving prod keys as is.
      prod: {
        apiKey: process.env.BLINDPAY_API_KEY ?? '',
        instanceId: process.env.BLINDPAY_INSTANCE_ID ?? '',
        webhookSecret: process.env.BLINDPAY_WEBHOOK_SECRET ?? '',
      },
      dev: {
        apiKey: process.env.BLINDPAY_API_KEY_DEV ?? '',
        instanceId: process.env.BLINDPAY_INSTANCE_ID_DEV ?? '',
        webhookSecret: process.env.BLINDPAY_WEBHOOK_SECRET_DEV ?? '',
      },
    },
  },
  plugins: {
    enabled: (process.env.PLUGINS_ENABLED ?? '')
      .split(',')
      .map((slug) => slug.trim())
      .filter(Boolean),
    secret: process.env.PLUGINS_SECRET?.trim() ?? '',
    trustedKeys: process.env.PLUGINS_TRUSTED_KEYS?.trim() ?? '',
    allowUnsigned:
      (process.env.PLUGINS_ALLOW_UNSIGNED ?? 'false').toLowerCase() === 'true',
  },
  defindex: {
    apiKey: process.env.DEFINDEX_API_KEY?.trim() ?? '',
    baseUrl: (
      process.env.DEFINDEX_BASE_URL ?? DEFAULT_DEFINDEX_BASE_URL
    ).replace(/\/+$/, ''),
    timeoutMs: parseInt(
      process.env.DEFINDEX_TIMEOUT_MS ?? String(DEFAULT_DEFINDEX_TIMEOUT_MS),
      10,
    ),
  },
  rateLimit: {
    enabled:
      (process.env.RATE_LIMIT_ENABLED ?? 'true').toLowerCase() !== 'false',
    pruneIntervalMs: parseInt(
      process.env.RATE_LIMIT_PRUNE_INTERVAL_MS ??
        String(DEFAULT_RATE_LIMIT_PRUNE_INTERVAL_MS),
      10,
    ),
  },
  walletAuth: {
    publicBaseUrl: (process.env.WALLET_AUTH_PUBLIC_BASE_URL ?? '').replace(
      /\/+$/,
      '',
    ),
    // No fallback to the gateway secret — see the interface, and
    // `identity-env.ts`, which refuses to boot without its own.
    sessionSecret: process.env.WALLET_AUTH_SESSION_SECRET?.trim() ?? '',
    consoleUrl: (process.env.WALLET_AUTH_CONSOLE_URL ?? '').replace(/\/+$/, ''),
    consoleSecret: process.env.WALLET_AUTH_CONSOLE_SECRET?.trim() ?? '',
    google: {
      clientId: process.env.WALLET_GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.WALLET_GOOGLE_CLIENT_SECRET ?? '',
    },
    github: {
      clientId: process.env.WALLET_GITHUB_CLIENT_ID ?? '',
      clientSecret: process.env.WALLET_GITHUB_CLIENT_SECRET ?? '',
    },
    oidc: {
      issuer: process.env.WALLET_AUTH_OIDC_ISSUER?.trim() ?? '',
      clientId: process.env.WALLET_AUTH_OIDC_CLIENT_ID?.trim() ?? '',
      clientSecret: process.env.WALLET_AUTH_OIDC_CLIENT_SECRET?.trim() ?? '',
    },
    // Each entry was checked at boot by `identity-env.ts`.
    returnUrls: parseReturnUrls(process.env.WALLET_AUTH_RETURN_URLS),
    signersHorizonUrl: (
      process.env.WALLET_AUTH_SIGNERS_HORIZON_URL?.trim() ||
      DEFAULT_HORIZON.public
    ).replace(/\/+$/, ''),
    sponsor: {
      secret: process.env.WALLET_RECOVERY_SPONSOR_SECRET?.trim() ?? '',
      networkPassphrase:
        process.env.WALLET_RECOVERY_SPONSOR_NETWORK_PASSPHRASE?.trim() ||
        NETWORK_PASSPHRASE_PUBLIC,
      horizonUrl: (
        process.env.WALLET_RECOVERY_SPONSOR_HORIZON_URL?.trim() ||
        DEFAULT_HORIZON.public
      ).replace(/\/+$/, ''),
    },
    timeoutMs: parseInt(
      process.env.WALLET_AUTH_TIMEOUT_MS ??
        String(DEFAULT_WALLET_AUTH_TIMEOUT_MS),
      10,
    ),
    sweep: {
      // Default on: an AUTHORIZED handshake left in the table is a redeemable
      // sign-in sitting there.
      enabled:
        (process.env.WALLET_AUTH_SWEEP_ENABLED ?? 'true').toLowerCase() !==
        'false',
      intervalMs: parseInt(
        process.env.WALLET_AUTH_SWEEP_INTERVAL_MS ??
          String(DEFAULT_WALLET_AUTH_SWEEP_INTERVAL_MS),
        10,
      ),
    },
  },
  recovery: {
    role:
      process.env.RECOVERY_ROLE === 'a' || process.env.RECOVERY_ROLE === 'b'
        ? process.env.RECOVERY_ROLE
        : null,
    publicBaseUrl: (process.env.RECOVERY_PUBLIC_BASE_URL ?? '')
      .trim()
      .replace(/\/+$/, ''),
    homeDomain: process.env.RECOVERY_HOME_DOMAIN?.trim() ?? '',
    networkPassphrase:
      process.env.RECOVERY_NETWORK_PASSPHRASE?.trim() ||
      NETWORK_PASSPHRASE_PUBLIC,
    horizonUrl: (
      process.env.RECOVERY_HORIZON_URL?.trim() || DEFAULT_HORIZON.public
    ).replace(/\/+$/, ''),
    signerMaster: process.env.RECOVERY_SIGNER_MASTER?.trim() ?? '',
    sep10SigningSecret: process.env.RECOVERY_SEP10_SIGNING_SECRET?.trim() ?? '',
    jwtSecret: process.env.RECOVERY_JWT_SECRET?.trim() ?? '',
    oidc: {
      issuer: process.env.RECOVERY_OIDC_ISSUER?.trim() ?? '',
      audiences: (process.env.RECOVERY_OIDC_AUDIENCES ?? '')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    },
    emailDelivery: {
      url: process.env.RECOVERY_EMAIL_DELIVERY_URL?.trim() ?? '',
      secret: process.env.RECOVERY_EMAIL_DELIVERY_SECRET?.trim() ?? '',
    },
    timeoutMs: parseInt(
      process.env.RECOVERY_TIMEOUT_MS ?? String(DEFAULT_RECOVERY_TIMEOUT_MS),
      10,
    ),
    sweep: {
      enabled:
        (process.env.RECOVERY_SWEEP_ENABLED ?? 'true').toLowerCase() !==
        'false',
      intervalMs: parseInt(
        process.env.RECOVERY_SWEEP_INTERVAL_MS ??
          String(DEFAULT_RECOVERY_SWEEP_INTERVAL_MS),
        10,
      ),
    },
  },
});
