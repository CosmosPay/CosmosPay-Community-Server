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
  Matches,
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
import { parseEvmTokenFees } from '@/config/evm-token-fees';
import { assertIdentityConfigConsistent } from '@/config/identity-env';

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

  @IsOptional()
  @IsString()
  APISIX_EMAIL_HEADER?: string;

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

  // --- Solana / Monad RPC (payment intents, wallet sign-in, aliases) ---
  @IsOptional()
  @IsUrl(URL_OPTIONS)
  SOLANA_RPC_URL_MAINNET?: string;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  SOLANA_RPC_URL_DEVNET?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  SOLANA_RPC_TIMEOUT_MS?: number;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  MONAD_RPC_URL_MAINNET?: string;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  MONAD_RPC_URL_TESTNET?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  MONAD_RPC_TIMEOUT_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  MONAD_LOG_BLOCK_RANGE?: number;

  /**
   * Turns on Monad deposit addresses. A hot key, but only for gas: the
   * forwarders it deploys can pay nobody but the merchant (and the relayer its
   * fee).
   */
  @IsOptional()
  @Matches(/^(0x)?[0-9a-fA-F]{64}$/, {
    message: 'MONAD_RELAYER_PRIVATE_KEY must be a 32-byte hex secret key',
  })
  MONAD_RELAYER_PRIVATE_KEY?: string;

  /** `{"0xToken…": "0.05"}` — checked in full by `parseEvmTokenFees`. */
  @IsOptional()
  @IsString()
  MONAD_DEPOSIT_TOKEN_FEES?: string;

  // --- Same-chain swaps off Stellar: Jupiter (Solana), Kuru Flow (Monad) ---
  /** Owner of the token accounts the Solana swap commission lands in. */
  @IsOptional()
  @Matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, {
    message: 'SOLANA_SWAP_FEE_WALLET must be a Solana address (base58)',
  })
  SOLANA_SWAP_FEE_WALLET?: string;

  @IsOptional()
  @Matches(/^0x[0-9a-fA-F]{40}$/, {
    message: 'MONAD_SWAP_FEE_WALLET must be an EVM address (0x + 40 hex)',
  })
  MONAD_SWAP_FEE_WALLET?: string;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  JUPITER_BASE_URL?: string;

  @IsOptional()
  @IsString()
  JUPITER_API_KEY?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  JUPITER_TIMEOUT_MS?: number;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  KURU_BASE_URL?: string;

  @IsOptional()
  @IsString()
  KURU_API_KEY?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  KURU_TIMEOUT_MS?: number;

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

  // --- Cross-chain swaps (NEAR Intents 1Click) ---
  @IsOptional()
  @IsUrl(URL_OPTIONS)
  NEAR_INTENTS_BASE_URL?: string;

  @IsOptional()
  @IsString()
  NEAR_INTENTS_API_KEY?: string;

  /**
   * A NEAR account id: named (`cosmospay.near`) or implicit (64 hex). Checked
   * here because a typo is not refused by 1Click at quote time — the commission
   * would accrue to an account nobody controls.
   */
  @IsOptional()
  @Matches(
    /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/,
    {
      message:
        'NEAR_INTENTS_FEE_RECIPIENT must be a NEAR account id (e.g. cosmospay.near)',
    },
  )
  NEAR_INTENTS_FEE_RECIPIENT?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  NEAR_INTENTS_TIMEOUT_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  CROSS_CHAIN_SWAP_SLIPPAGE_BPS?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  CROSS_CHAIN_SWAP_MAX_SLIPPAGE_BPS?: number;

  @IsOptional()
  @IsInt()
  @Min(60)
  CROSS_CHAIN_SWAP_DEADLINE_SECONDS?: number;

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

  // --- BlindPay (onramp / offramp / KYC rails) — the `blindpay` native plugin ---
  // All optional here: the plugin checks that each instance's trio is whole when
  // it boots (`assertBlindpayInstancesConsistent`), and a deployment that does
  // not enable it never reads them.
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

  @IsOptional()
  @IsString()
  DEFINDEX_API_KEY?: string;

  /** Comma-separated slugs of the plugins in `plugins/` to serve. */
  @IsOptional()
  @IsString()
  PLUGINS_ENABLED?: string;

  /**
   * Seals the secret config fields of plugin installations. Checked for
   * presence by the plugin registry, which knows whether any enabled plugin
   * declares one.
   */
  @IsOptional()
  @IsString()
  @MinLength(32)
  PLUGINS_SECRET?: string;

  /** Signers whose plugins run here, beside support's; checked by the loader. */
  @IsOptional()
  @IsString()
  PLUGINS_TRUSTED_KEYS?: string;

  @IsOptional()
  @IsBooleanString()
  PLUGINS_ALLOW_UNSIGNED?: string;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  DEFINDEX_BASE_URL?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  DEFINDEX_TIMEOUT_MS?: number;

  /**
   * Per-consumer KYC redirect_url host allow-list (issue #33). Optional at boot —
   * missing/empty means every consumer fails closed until configured. Shape:
   * {"cosmos_acme":["acme.com","app.acme.com"]}
   */
  @IsOptional()
  @IsString()
  KYC_REDIRECT_URL_WHITELIST?: string;

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

function isNonEmpty(value: string | undefined): value is string {
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

  assertIdentityConfigConsistent(config);

  // Parsed here as well, so a malformed value fails the boot naming its
  // variable instead of surfacing from the configuration factory.
  parseEvmTokenFees(validated.MONAD_DEPOSIT_TOKEN_FEES);

  return validated;
}
