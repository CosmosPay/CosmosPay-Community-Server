import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
  type ValidationError,
} from 'class-validator';
import { StrKey } from '@stellar/stellar-sdk';

const URL_OPTIONS = {
  require_protocol: true,
  protocols: ['http', 'https'],
  require_tld: false,
};

import {
  DEFAULT_SWAP_FEE_BPS,
  DEFAULT_SWAP_MAX_SLIPPAGE_BPS,
  DEFAULT_SWAP_SLIPPAGE_BPS,
} from '@/config/config.constants';
import { POLLAR_KEY_PREFIX } from '@/config/pollar-key-prefix';
import { decodeSvixSecret } from '@/blindpay/blindpay-signature';
import { SVIX_MIN_SECRET_BYTES } from '@/blindpay/blindpay.constants';

/**
 * Gateway secrets that are documentation, not secrets. `.env.example` used to
 * ship `replace-with-a-long-random-secret-min-32-chars`, which clears the
 * 32-character floor — so a deployment that copied the example and never
 * replaced it booted behind a value printed in a public repository, and anyone
 * who could reach the pod could name any consumer and reach `/v1/admin`. No
 * generated secret (hex or base64) can contain these words with separators.
 */
const PLACEHOLDER_SECRET_RE =
  /replace[-_ ]?(with|me)|change[-_ ]?me|your[-_ ]?secret|placeholder/i;

/**
 * Schema used by ConfigModule to fail fast at boot if the environment is
 * misconfigured. APISIX_GATEWAY_SECRET is always required — the whole point of
 * the service is to only trust requests carrying the secret the gateway injects.
 */
class EnvironmentVariables {
  @IsOptional()
  @IsIn(['development', 'test', 'production'])
  NODE_ENV?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(65535)
  PORT?: number;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  /**
   * The shared secret that separates "arrived through APISIX" from "anyone who
   * can reach the pod" — and, since the admin credential was removed, the only
   * secret in front of the cross-tenant `/v1/admin` surface as well. It used to
   * accept a single character; 32 is the floor for a boundary carrying that.
   */
  @IsOptional()
  @IsString()
  @MinLength(32)
  APISIX_GATEWAY_SECRET?: string;

  @IsOptional()
  @IsString()
  APISIX_GATEWAY_SECRET_HEADER?: string;

  @IsOptional()
  @IsString()
  APISIX_CONSUMER_HEADER?: string;

  @IsOptional()
  @IsString()
  APISIX_CREDENTIAL_HEADER?: string;

  @IsOptional()
  @IsString()
  APISIX_ENVIRONMENT_HEADER?: string;

  @IsOptional()
  @IsString()
  APISIX_ROLE_HEADER?: string;

  @IsOptional()
  @IsString()
  APISIX_PERMISSIONS_HEADER?: string;

  @IsOptional()
  @IsString()
  APISIX_ORGANIZATION_HEADER?: string;

  @IsOptional()
  @IsString()
  APISIX_PLAN_HEADER?: string;

  @IsOptional()
  @IsString()
  APISIX_SWAP_FEE_BPS_HEADER?: string;

  /**
   * APISIX username of the shared public consumer (the wallet's embedded key),
   * e.g. `cosmos_public`. Optional: a deployment that publishes no public key
   * leaves it unset and PublicKeyGuard then relies on the forwarded role alone.
   */
  @IsOptional()
  @IsString()
  APISIX_PUBLIC_CONSUMER?: string;

  @IsOptional()
  @IsIn(['public', 'testnet'])
  STELLAR_NETWORK?: string;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  STELLAR_HORIZON_URL_PUBLIC?: string;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  STELLAR_HORIZON_URL_TESTNET?: string;

  @IsOptional()
  @IsString()
  STELLAR_BASE_FEE?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  STELLAR_TX_TIMEOUT?: number;

  // --- Stellar native swaps (path-payment asset exchange) ---
  @IsOptional()
  @IsString()
  STELLAR_SWAP_FEE_WALLET?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  STELLAR_SWAP_FEE_BPS?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  STELLAR_SWAP_SLIPPAGE_BPS?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  STELLAR_SWAP_MAX_SLIPPAGE_BPS?: number;

  /** When "true", at most one non-expired PENDING swap per (consumer, source, network). */
  @IsOptional()
  @IsBooleanString()
  STELLAR_SWAP_SINGLE_INFLIGHT?: string;

  // --- Webhook delivery sweeper (recovers deliveries stranded by a crash) ---
  @IsOptional()
  @IsBooleanString()
  WEBHOOK_SWEEP_ENABLED?: string;

  @IsOptional()
  @IsInt()
  @Min(1000)
  WEBHOOK_SWEEP_INTERVAL_MS?: number;

  /**
   * Days to keep the body of a settled webhook delivery. A RECEIVER_UPDATED
   * body is the provider's full KYC dossier, so it is cleared once the delivery
   * is terminal and past any redelivery window. 0 keeps bodies forever.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  WEBHOOK_PAYLOAD_RETENTION_DAYS?: number;

  // --- On-chain observer + payment intent lifetime ---
  @IsOptional()
  @IsBooleanString()
  OBSERVER_ENABLED?: string;

  @IsOptional()
  @IsInt()
  @Min(1000)
  OBSERVER_INTERVAL_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  OBSERVER_BATCH_SIZE?: number;

  // --- Request log retention (PII prune) ---
  @IsOptional()
  @IsInt()
  @Min(0)
  REQUEST_LOG_RETENTION_DAYS?: number;

  /**
   * Days to keep client-reported activity events (`activity_event`). Pruned on
   * the same timer and in the same bounded batches as the request log, because
   * a row holds an IP, a user agent and whatever the client put in `props`.
   * 0 keeps them forever.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  ACTIVITY_RETENTION_DAYS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  REQUEST_LOG_PRUNE_INTERVAL_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  REQUEST_LOG_PRUNE_BATCH_SIZE?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  REQUEST_LOG_PRUNE_MAX_PER_CYCLE?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  PAYMENT_INTENT_TTL_SECONDS?: number;

  // --- Outbound webhooks ---
  @IsOptional()
  @IsInt()
  @Min(1)
  WEBHOOK_TIMEOUT_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  WEBHOOK_CONNECT_TIMEOUT_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  WEBHOOK_READ_TIMEOUT_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  WEBHOOK_MAX_RESPONSE_BYTES?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  WEBHOOK_MAX_ATTEMPTS?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  WEBHOOK_BACKOFF_MS?: number;

  @IsOptional()
  @IsString()
  WEBHOOK_SIGNATURE_HEADER?: string;

  // --- OpenAPI / Swagger ---
  @IsOptional()
  @IsUrl(URL_OPTIONS)
  OPENAPI_SERVER_URL?: string;

  @IsOptional()
  @IsBooleanString()
  SWAGGER_ENABLED?: string;

  // --- BlindPay (onramp / offramp / KYC rails) ---
  // All optional: the service boots without them; the BlindPay client fails with
  // a clear 503 only when a BlindPay-backed route is actually exercised.
  @IsOptional()
  @IsString()
  BLINDPAY_API_KEY?: string;

  @IsOptional()
  @IsString()
  BLINDPAY_INSTANCE_ID?: string;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  BLINDPAY_BASE_URL?: string;

  @IsOptional()
  @IsString()
  BLINDPAY_WEBHOOK_SECRET?: string;

  // The development instance, served to `dev` API keys. Same rules as the
  // production trio above; unset means dev keys get 503 `misconfigured` from
  // every BlindPay route instead of reaching production.
  @IsOptional()
  @IsString()
  BLINDPAY_API_KEY_DEV?: string;

  @IsOptional()
  @IsString()
  BLINDPAY_INSTANCE_ID_DEV?: string;

  @IsOptional()
  @IsString()
  BLINDPAY_WEBHOOK_SECRET_DEV?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  BLINDPAY_TIMEOUT_MS?: number;

  /**
   * Per-consumer KYC redirect_url host allow-list (issue #33). Optional at boot —
   * missing/empty means every consumer fails closed until configured. Shape:
   * {"cosmos_acme":["acme.com","app.acme.com"]}
   */
  @IsOptional()
  @IsString()
  KYC_REDIRECT_URL_WHITELIST?: string;

  // --- Pollar (hosted OAuth + virtual Stellar wallets) ---
  // All optional: the service boots without them and the Pollar routes return
  // 503 only when one is actually exercised. Keys are network-specific by
  // prefix, so each network has its own pair.
  @IsOptional()
  @IsString()
  POLLAR_PUBLISHABLE_KEY_TESTNET?: string;

  @IsOptional()
  @IsString()
  POLLAR_PUBLISHABLE_KEY_MAINNET?: string;

  @IsOptional()
  @IsString()
  POLLAR_SECRET_KEY_TESTNET?: string;

  @IsOptional()
  @IsString()
  POLLAR_SECRET_KEY_MAINNET?: string;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  POLLAR_SDK_BASE_URL?: string;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  POLLAR_SERVER_BASE_URL?: string;

  /**
   * The `Origin` presented to Pollar's SDK API, which checks it against the
   * app's Build -> Domains list. Defaults to the origin of
   * POLLAR_BRIDGE_CALLBACK_URL, which already has to be registered there — set
   * this only when the two differ.
   */
  @IsOptional()
  @IsUrl(URL_OPTIONS)
  POLLAR_SDK_ORIGIN?: string;

  /**
   * Public URL of this service's Pollar OAuth callback, as a browser reaches it
   * through the gateway. Handed to Pollar as `redirect_uri`, so it must also be
   * registered in the Pollar dashboard under Build -> Domains.
   */
  @IsOptional()
  @IsUrl(URL_OPTIONS)
  POLLAR_BRIDGE_CALLBACK_URL?: string;

  /**
   * Per-consumer allow-list of wallet redirect URIs the bridge may hand a code
   * to. Missing/empty means a consumer can only use the poll flow. Shape:
   * {"cosmos_acme":["cosmospay://auth","http://127.0.0.1"]}
   */
  @IsOptional()
  @IsString()
  POLLAR_REDIRECT_URI_WHITELIST?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  POLLAR_TIMEOUT_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  POLLAR_AUTHORIZATION_TTL_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  POLLAR_CODE_TTL_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  POLLAR_LOGIN_WAIT_MS?: number;

  @IsOptional()
  @IsBooleanString()
  POLLAR_SWEEP_ENABLED?: string;

  @IsOptional()
  @IsInt()
  @Min(1000)
  POLLAR_SWEEP_INTERVAL_MS?: number;

  // --- Rate limiting ---
  /**
   * Master switch for the per-address caps declared with `@RateLimit`. Default
   * on: the routes it guards create and fund Stellar accounts, so uncapped is
   * not a state to arrive at by forgetting a variable.
   */
  @IsOptional()
  @IsBooleanString()
  RATE_LIMIT_ENABLED?: string;

  @IsOptional()
  @IsInt()
  @Min(1000)
  RATE_LIMIT_PRUNE_INTERVAL_MS?: number;
}

function formatValidationErrors(errors: ValidationError[]): string {
  return errors
    .flatMap((error) => {
      const property = error.property;
      const constraints = Object.values(error.constraints ?? {});
      return constraints.map((message) => `${property}: ${message}`);
    })
    .join('\n');
}

function isNonEmpty(value: string | undefined): boolean {
  return value != null && value.trim() !== '';
}

function effectiveSwapFeeBps(validated: EnvironmentVariables): number {
  return validated.STELLAR_SWAP_FEE_BPS ?? DEFAULT_SWAP_FEE_BPS;
}

function effectiveSlippageBps(validated: EnvironmentVariables): number {
  return validated.STELLAR_SWAP_SLIPPAGE_BPS ?? DEFAULT_SWAP_SLIPPAGE_BPS;
}

function effectiveMaxSlippageBps(validated: EnvironmentVariables): number {
  return (
    validated.STELLAR_SWAP_MAX_SLIPPAGE_BPS ?? DEFAULT_SWAP_MAX_SLIPPAGE_BPS
  );
}

export function validateEnv(config: Record<string, unknown>) {
  // Warn, don't throw: a leftover value breaks nothing, but an operator who still
  // sees it in their .env will believe the admin surface is gated by it. It is not
  // read at all -- `/v1/admin` now admits the platform console, which decides who is
  // a platform admin against the signed-in account's role.
  if (isNonEmpty(config.ADMIN_API_CREDENTIALS as string | undefined)) {
    new Logger('EnvValidation').warn(
      'ADMIN_API_CREDENTIALS is set but no longer read: /v1/admin is gated on the ' +
        'call coming from the platform console (gateway secret + X-Cosmos-Internal), ' +
        'not on an admin secret. Delete the variable.',
    );
  }

  const legacyHorizonUrl = config.STELLAR_HORIZON_URL;
  if (typeof legacyHorizonUrl === 'string' && legacyHorizonUrl.trim() !== '') {
    throw new Error(
      'STELLAR_HORIZON_URL is no longer used: rename it to ' +
        'STELLAR_HORIZON_URL_PUBLIC or STELLAR_HORIZON_URL_TESTNET so the ' +
        'service actually points at your Horizon instance.',
    );
  }

  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${formatValidationErrors(errors)}`,
    );
  }

  if (!validated.APISIX_GATEWAY_SECRET) {
    throw new Error(
      'APISIX_GATEWAY_SECRET is required: the service only trusts requests that ' +
        'carry the shared secret APISIX injects. Set it to match the dev platform ' +
        "(COSMOS_GATEWAY_SECRET) and the gateway route's X-Gateway-Secret.",
    );
  }

  if (PLACEHOLDER_SECRET_RE.test(validated.APISIX_GATEWAY_SECRET)) {
    throw new Error(
      'APISIX_GATEWAY_SECRET is still a placeholder: it is the only thing between ' +
        '"arrived through APISIX" and anyone who can reach this service. Generate ' +
        'one (openssl rand -hex 32) and set the same value on the gateway route.',
    );
  }

  const feeBps = effectiveSwapFeeBps(validated);
  if (feeBps > 0) {
    const wallet = validated.STELLAR_SWAP_FEE_WALLET?.trim() ?? '';
    if (!wallet) {
      throw new Error(
        'STELLAR_SWAP_FEE_WALLET is required when STELLAR_SWAP_FEE_BPS is greater ' +
          'than zero: swap fees are paid to this Stellar account (G...). Set the ' +
          'wallet or disable the fee with STELLAR_SWAP_FEE_BPS=0.',
      );
    }
    if (!StrKey.isValidEd25519PublicKey(wallet)) {
      throw new Error(
        'STELLAR_SWAP_FEE_WALLET must be a valid Stellar account address (G...) ' +
          'when STELLAR_SWAP_FEE_BPS is greater than zero.',
      );
    }
  }

  const slippageBps = effectiveSlippageBps(validated);
  const maxSlippageBps = effectiveMaxSlippageBps(validated);
  if (slippageBps > maxSlippageBps) {
    throw new Error(
      'STELLAR_SWAP_SLIPPAGE_BPS must be less than or equal to ' +
        'STELLAR_SWAP_MAX_SLIPPAGE_BPS so callers cannot request slippage ' +
        'above the configured hard cap.',
    );
  }

  assertBlindpayInstancesConsistent(validated);

  assertPollarKeysConsistent(validated);

  return validated;
}

/**
 * Each BlindPay instance is configured by its own trio of variables — unsuffixed
 * for production, `_DEV` for development — and a trio must be whole: an instance
 * id is required alongside its key, and so is the webhook secret, because without
 * it that instance's deliveries cannot be verified at all.
 */
function assertBlindpayInstancesConsistent(
  validated: EnvironmentVariables,
): void {
  const instances = [
    {
      apiKey: validated.BLINDPAY_API_KEY,
      apiKeyVar: 'BLINDPAY_API_KEY',
      instanceId: validated.BLINDPAY_INSTANCE_ID,
      instanceIdVar: 'BLINDPAY_INSTANCE_ID',
      webhookSecret: validated.BLINDPAY_WEBHOOK_SECRET,
      webhookSecretVar: 'BLINDPAY_WEBHOOK_SECRET',
    },
    {
      apiKey: validated.BLINDPAY_API_KEY_DEV,
      apiKeyVar: 'BLINDPAY_API_KEY_DEV',
      instanceId: validated.BLINDPAY_INSTANCE_ID_DEV,
      instanceIdVar: 'BLINDPAY_INSTANCE_ID_DEV',
      webhookSecret: validated.BLINDPAY_WEBHOOK_SECRET_DEV,
      webhookSecretVar: 'BLINDPAY_WEBHOOK_SECRET_DEV',
    },
  ];

  for (const instance of instances) {
    if (isNonEmpty(instance.apiKey)) {
      if (!isNonEmpty(instance.instanceId)) {
        throw new Error(
          `${instance.instanceIdVar} is required when ${instance.apiKeyVar} is set: ` +
            'every BlindPay API call is scoped to a platform instance id (in_...).',
        );
      }
      if (!isNonEmpty(instance.webhookSecret)) {
        throw new Error(
          `${instance.webhookSecretVar} is required when ${instance.apiKeyVar} is set: ` +
            'inbound BlindPay webhooks are verified with the Svix signing secret (whsec_...).',
        );
      }
    }

    // Checked whenever it is set, not only alongside the API key: the inbound
    // webhook route reads it on its own.
    if (
      isNonEmpty(instance.webhookSecret) &&
      !decodeSvixSecret(instance.webhookSecret as string)
    ) {
      throw new Error(
        `${instance.webhookSecretVar} is not a usable Svix signing secret: it must be the ` +
          'whsec_... value BlindPay shows for the endpoint, whose base64 key decodes ' +
          `to at least ${SVIX_MIN_SECRET_BYTES} bytes. A truncated or mistyped secret ` +
          'decodes to a short or empty key, and a webhook signed with that proves nothing.',
      );
    }
  }
}

/**
 * Pollar keys carry their key type and network in the prefix, and the API
 * rejects a mismatch with `API_KEY_TYPE_NOT_ALLOWED` — at request time, on a
 * user-facing login. Catching it at boot turns a mystery 403 into a startup
 * error naming the variable. A configured network also needs both halves: the
 * publishable key drives the OAuth bridge and the secret key the operator
 * routes, and half a pair is a feature that fails on its second call.
 */
function assertPollarKeysConsistent(validated: EnvironmentVariables): void {
  const pairs = [
    {
      network: 'testnet' as const,
      publishable: validated.POLLAR_PUBLISHABLE_KEY_TESTNET,
      publishableVar: 'POLLAR_PUBLISHABLE_KEY_TESTNET',
      secret: validated.POLLAR_SECRET_KEY_TESTNET,
      secretVar: 'POLLAR_SECRET_KEY_TESTNET',
    },
    {
      network: 'public' as const,
      publishable: validated.POLLAR_PUBLISHABLE_KEY_MAINNET,
      publishableVar: 'POLLAR_PUBLISHABLE_KEY_MAINNET',
      secret: validated.POLLAR_SECRET_KEY_MAINNET,
      secretVar: 'POLLAR_SECRET_KEY_MAINNET',
    },
  ];

  for (const pair of pairs) {
    const hasPublishable = isNonEmpty(pair.publishable);
    const hasSecret = isNonEmpty(pair.secret);
    if (!hasPublishable && !hasSecret) continue;

    if (!hasPublishable || !hasSecret) {
      throw new Error(
        `${pair.publishableVar} and ${pair.secretVar} must be set together: the ` +
          'publishable key authenticates the OAuth bridge and the secret key the ' +
          'operator routes, and Pollar refuses each on the other API.',
      );
    }

    assertKeyPrefix(
      pair.publishableVar,
      pair.publishable,
      POLLAR_KEY_PREFIX.publishable[pair.network],
    );
    assertKeyPrefix(
      pair.secretVar,
      pair.secret,
      POLLAR_KEY_PREFIX.secret[pair.network],
    );
  }

  if (
    (isNonEmpty(validated.POLLAR_PUBLISHABLE_KEY_TESTNET) ||
      isNonEmpty(validated.POLLAR_PUBLISHABLE_KEY_MAINNET)) &&
    !isNonEmpty(validated.POLLAR_BRIDGE_CALLBACK_URL)
  ) {
    throw new Error(
      'POLLAR_BRIDGE_CALLBACK_URL is required when a Pollar key is set: it is the ' +
        'redirect_uri Pollar returns the browser to, so the bridge cannot build an ' +
        'authorization URL without it. Point it at this service through the gateway ' +
        '(e.g. https://gateway.example.com/v1/pollar/oauth/callback) and register ' +
        'that host in the Pollar dashboard under Build -> Domains.',
    );
  }
}

function assertKeyPrefix(
  name: string,
  value: string | undefined,
  prefix: string,
): void {
  if (value && !value.startsWith(prefix)) {
    throw new Error(
      `${name} must start with '${prefix}': Pollar encodes the key type and ` +
        'network in the prefix and rejects a key used on the wrong API or network.',
    );
  }
}
