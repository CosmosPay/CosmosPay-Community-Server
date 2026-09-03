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
import { POLLAR_KEY_PREFIX } from '@/pollar/pollar.constants';

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
   * can reach the pod". Admin credentials already require 16 chars
   * (`parseAdminCredentials`); this is a stronger boundary and used to accept a
   * single character.
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

  @IsOptional()
  @IsInt()
  @Min(1)
  BLINDPAY_TIMEOUT_MS?: number;

  /**
   * Platform-admin credentials JSON (issue #34). Optional at boot — empty means
   * admin routes fail closed. Shape:
   * [{"id":"viewer","secret":"…","role":"read"},{"id":"owner","secret":"…","role":"write"}]
   */
  @IsOptional()
  @IsString()
  ADMIN_API_CREDENTIALS?: string;

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

  if (isNonEmpty(validated.BLINDPAY_API_KEY)) {
    if (!isNonEmpty(validated.BLINDPAY_INSTANCE_ID)) {
      throw new Error(
        'BLINDPAY_INSTANCE_ID is required when BLINDPAY_API_KEY is set: every ' +
          'BlindPay API call is scoped to a platform instance id (in_...).',
      );
    }
    if (!isNonEmpty(validated.BLINDPAY_WEBHOOK_SECRET)) {
      throw new Error(
        'BLINDPAY_WEBHOOK_SECRET is required when BLINDPAY_API_KEY is set: inbound ' +
          'BlindPay webhooks are verified with the Svix signing secret (whsec_...).',
      );
    }
  }

  assertPollarKeysConsistent(validated);

  return validated;
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
