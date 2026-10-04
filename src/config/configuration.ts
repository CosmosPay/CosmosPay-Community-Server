import {
  DEFAULT_DEFINDEX_BASE_URL,
  DEFAULT_DEFINDEX_TIMEOUT_MS,
  DEFAULT_ENV_FILE,
  DEFAULT_CHAIN_RPC_TIMEOUT_MS,
  DEFAULT_CROSS_CHAIN_DEADLINE_SECONDS,
  DEFAULT_CROSS_CHAIN_MAX_SLIPPAGE_BPS,
  DEFAULT_CROSS_CHAIN_SLIPPAGE_BPS,
  DEFAULT_HORIZON,
  DEFAULT_JUPITER_BASE_URL,
  DEFAULT_KURU_BASE_URL,
  DEFAULT_MONAD_LOG_BLOCK_RANGE,
  DEFAULT_MONAD_RPC,
  DEFAULT_NEAR_INTENTS_BASE_URL,
  DEFAULT_NEAR_INTENTS_TIMEOUT_MS,
  DEFAULT_RATE_LIMIT_PRUNE_INTERVAL_MS,
  DEFAULT_RECOVERY_SWEEP_INTERVAL_MS,
  DEFAULT_RECOVERY_TIMEOUT_MS,
  DEFAULT_SOLANA_RPC,
  DEFAULT_SWAP_AGGREGATOR_TIMEOUT_MS,
  DEFAULT_WALLET_AUTH_SWEEP_INTERVAL_MS,
  DEFAULT_WALLET_AUTH_TIMEOUT_MS,
  NETWORK_PASSPHRASE,
  NETWORK_PASSPHRASE_PUBLIC,
} from '@/config/config.constants';
import { parseReturnUrls } from '@/common/return-url';
import {
  DEFAULT_APISIX_ADMIN_TIMEOUT_MS,
  DEFAULT_WALLET_KEY_SWAP_FEE_BPS,
} from '@/gateway-keys/gateway-keys.constants';
import { keyringFrom, type BackupKeyring } from '@/wallet-auth/backup-cipher';
import {
  DEFAULT_MAIL_SMTP_PORT,
  DEFAULT_MAIL_TIMEOUT_MS,
} from '@/mailer/mailer.constants';
import {
  parseRedirectUrlWhitelist,
  type RedirectUrlWhitelist,
} from '@/config/kyc-redirect-url-whitelist';
import { type EvmTokenFees, parseEvmTokenFees } from '@/config/evm-token-fees';
import {
  isNativePluginSlug,
  type NativePluginSlug,
} from '@/plugins/plugins.constants';

/** The slugs in `PLUGINS_ENABLED`, sandboxed and native alike. */
function parsePluginsEnabled(env: NodeJS.ProcessEnv): string[] {
  return (env.PLUGINS_ENABLED ?? '')
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean);
}

/**
 * Whether `PLUGINS_ENABLED` names a native plugin — the condition
 * `NativePluginsModule` imports it on. It has to be a predicate over the
 * environment rather than a `ConfigService` read, because it decides which
 * modules exist, before any provider does.
 */
export function nativePluginEnabled(
  slug: NativePluginSlug,
): (env: NodeJS.ProcessEnv) => boolean {
  return (env) => parsePluginsEnabled(env).includes(slug);
}

/**
 * The dotenv file this process reads: `ENV_FILE`, or `.env`.
 *
 * A function over the raw environment rather than config, because it decides
 * where the config comes FROM — ConfigModule needs it before any provider
 * exists. Values already in the environment win over the file, which is what
 * lets several instances run from one checkout and one `.env`:
 * `npm run dev:local` starts each with its own differences (dev-instances.json)
 * already set, and a value set to "" is one the file cannot fill back in.
 */
export function envFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENV_FILE?.trim() || DEFAULT_ENV_FILE;
}

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
  /**
   * The APISIX Admin API, used for one thing: minting the gateway keys of a
   * wallet account at the end of its sign-in (`WalletKeysService`). Unset means
   * this deployment cannot finish a sign-in. The client only writes consumers
   * under `cosmos_wallet_`, but the key itself is gateway-wide — see the README.
   */
  apisixAdmin: {
    url: string;
    key: string;
    timeoutMs: number;
    /** Swap commission (bps) baked into a wallet account's keys. */
    walletSwapFeeBps: number;
  };
  /**
   * The shared public key per environment, served keyless at `GET /v1/public-key`
   * to wallets that have no account. Empty answers 503 for that environment.
   */
  publicKeys: { dev: string; prod: string };
  /**
   * This service's own sender: Resend when `resendApiKey` is set, otherwise SMTP.
   * No `from`, or neither transport, disables every email door.
   */
  mail: {
    resendApiKey: string;
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      user: string;
      pass: string;
    };
    from: string;
    timeoutMs: number;
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
  /**
   * Solana, per network tier: `public` is mainnet-beta, `testnet` is devnet —
   * the tier the caller's API key picks, exactly as for Stellar.
   */
  solana: {
    rpcUrls: Record<StellarNetwork, string>;
    timeoutMs: number;
    /**
     * Owner of the token accounts the Solana swap commission is paid into
     * (Jupiter's `feeAccount` is this wallet's account for the output mint).
     * Empty disables the commission; a plan that charges one then refuses.
     */
    swapFeeWallet: string;
  };
  /**
   * Monad (EVM), per network tier: `public` is mainnet, `testnet` is Monad's
   * testnet. The chain ids are not configurable — see `MONAD_CHAIN_IDS`.
   */
  monad: {
    rpcUrls: Record<StellarNetwork, string>;
    timeoutMs: number;
    /** Blocks one `eth_getLogs` call may span; the RPC provider's limit. */
    logBlockRange: number;
    /**
     * The relayer's secret key (hex). Set, every Monad PAY intent gets its own
     * CREATE2 deposit address and the relayer forwards what arrives; empty,
     * Monad intents pay the merchant directly and are matched by amount. It
     * holds gas money only — see `contracts/PaymentForwarder.sol`.
     */
    relayerPrivateKey: string;
    /** Per-token relayer fees for token deposits (`MONAD_DEPOSIT_TOKEN_FEES`). */
    depositTokenFees: EvmTokenFees;
    /**
     * The address the Monad swap commission is paid to (Kuru Flow's
     * `referrerAddress`). Empty disables it; a plan that charges one refuses.
     */
    swapFeeWallet: string;
  };
  /**
   * The aggregators that build same-chain swaps off Stellar: Jupiter on
   * Solana, Kuru Flow on Monad. Mainnet only, both of them.
   */
  swapAggregators: {
    jupiter: { baseUrl: string; apiKey: string; timeoutMs: number };
    kuru: { baseUrl: string; apiKey: string; timeoutMs: number };
  };
  /**
   * Cross-chain swaps, settled by NEAR Intents' 1Click API. Mainnet only:
   * 1Click has no test network, so a `dev` key can quote but not create.
   */
  nearIntents: {
    baseUrl: string;
    /**
     * The partner key (`X-API-Key`). Optional to 1Click, not to the operator:
     * without it 1Click adds a fee of its own and takes a share of ours.
     */
    apiKey: string;
    /**
     * The NEAR Intents account the plan commission is paid to (`appFees`).
     * Empty disables the commission; a plan that charges one then refuses to
     * quote rather than swap for free.
     */
    feeRecipient: string;
    timeoutMs: number;
    slippageBps: number;
    maxSlippageBps: number;
    deadlineSeconds: number;
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
     * The native plugins (`src/native-plugins/`) named in the same
     * `PLUGINS_ENABLED` list. One that is not listed is never instantiated: its
     * routes do not exist and its background jobs never start.
     */
    native: NativePluginSlug[];
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
    /** Load plugins with no signature. Refused when NODE_ENV=production. */
    allowUnsigned: boolean;
    /**
     * Whether node started with `--no-node-snapshot`, which the plugin sandbox
     * (`isolated-vm`) requires on Node 20+. Checked at boot when a plugin is
     * enabled; the npm scripts pass it.
     */
    nodeSnapshotDisabled: boolean;
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
     * The at-rest keys for stored wallet backups (`BackupCipher`): the current one
     * seals every write, the previous ones only read rows written before a
     * rotation. Kept out of the database on purpose — see `backup-cipher.ts`.
     */
    backupKeyring: BackupKeyring;
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
     * whose key is no longer its address — per ledger, because a SEP-30 re-key
     * lands on ONE ledger and the wallet says which. The URLs are the operator's,
     * never the request's: a caller may name `public` or `testnet`, and that only
     * picks which of these two this service reads.
     */
    signersHorizonUrls: Record<StellarNetwork, string>;
    /** The ledger read when a request names none — every client before the field. */
    signersNetwork: StellarNetwork;
    /**
     * Pays the reserve of an account's two recovery signers
     * (`POST /v1/wallet/recovery/setup`). Unset disables the route. Refused at
     * boot on a recovery server.
     *
     * `networkPassphrase` / `horizonUrl` are the ledger a request that names none
     * is sponsored on; `networks` is every ledger the same key sponsors on (it
     * must hold a balance on each).
     */
    sponsor: {
      secret: string;
      networkPassphrase: string;
      horizonUrl: string;
      networks: Partial<
        Record<
          StellarNetwork,
          { networkPassphrase: string; horizonUrl: string }
        >
      >;
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
    /** The DEFAULT ledger: served on the routes that name no network, as before. */
    networkPassphrase: string;
    horizonUrl: string;
    /**
     * Every ledger this server recovers on, by name: `stellar.toml?network=`,
     * `/v1/sep10/{network}/auth`, `/v1/sep30/{network}/…`. A signer is an entry
     * on one ledger, so each is its own registration and its own SEP-10 token.
     */
    networks: Partial<
      Record<StellarNetwork, { networkPassphrase: string; horizonUrl: string }>
    >;
    signerMaster: string;
    sep10SigningSecret: string;
    jwtSecret: string;
    /** ID tokens this server exchanges for an identity; empty issuer disables it. */
    oidc: { issuer: string; audiences: string[] };
    /**
     * Whether this server emails its own codes, through its own `MAIL_*`
     * sender. Off disables that way of proving an inbox.
     */
    emailCodes: boolean;
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

/** `STELLAR_NETWORK`: the fallback network, and the one Stellar defaults follow. */
function stellarNetwork(): StellarNetwork {
  return (process.env.STELLAR_NETWORK ?? 'testnet').toLowerCase() === 'public'
    ? 'public'
    : 'testnet';
}

/** The operator's Horizon for each network: `STELLAR_HORIZON_URL_*`, else SDF's. */
function operatorHorizon(): Record<StellarNetwork, string> {
  return {
    public: process.env.STELLAR_HORIZON_URL_PUBLIC ?? DEFAULT_HORIZON.public,
    testnet: process.env.STELLAR_HORIZON_URL_TESTNET ?? DEFAULT_HORIZON.testnet,
  };
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/** The ledger a passphrase names, or null for a custom network. */
export function stellarNetworkOf(passphrase: string): StellarNetwork | null {
  if (passphrase === NETWORK_PASSPHRASE.public) return 'public';
  if (passphrase === NETWORK_PASSPHRASE.testnet) return 'testnet';
  return null;
}

/**
 * A comma list of ledger names (`public,testnet`). Anything else is dropped here
 * and refused at boot by `identity-env.ts`, so a typo never silently serves less.
 */
function networkList(raw: string | undefined): StellarNetwork[] {
  const names = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is StellarNetwork => s === 'public' || s === 'testnet');
  return [...new Set(names)];
}

/**
 * The ledgers a deployment serves: its own (`passphrase` + `horizonUrl`, when
 * that is a named network) plus every one `listed`. Each other ledger's Horizon
 * is `horizonFor(n)`.
 */
function ledgers(
  passphrase: string,
  horizonUrl: string,
  listed: StellarNetwork[],
  horizonFor: (n: StellarNetwork) => string,
): Partial<
  Record<StellarNetwork, { networkPassphrase: string; horizonUrl: string }>
> {
  const own = stellarNetworkOf(passphrase);
  const out: Partial<
    Record<StellarNetwork, { networkPassphrase: string; horizonUrl: string }>
  > = {};
  for (const n of own && !listed.includes(own) ? [own, ...listed] : listed) {
    out[n] = {
      networkPassphrase: NETWORK_PASSPHRASE[n],
      horizonUrl: trimSlash(n === own ? horizonUrl : horizonFor(n)),
    };
  }
  return out;
}

/** The recovery server's ledgers — see `AppConfig.recovery.networks`. */
function recoveryLedgers() {
  const networkPassphrase =
    process.env.RECOVERY_NETWORK_PASSPHRASE?.trim() ||
    NETWORK_PASSPHRASE_PUBLIC;
  const horizonUrl = trimSlash(
    process.env.RECOVERY_HORIZON_URL?.trim() || DEFAULT_HORIZON.public,
  );
  const networks = ledgers(
    networkPassphrase,
    horizonUrl,
    networkList(process.env.RECOVERY_NETWORKS),
    (n) =>
      process.env[`RECOVERY_HORIZON_URL_${n.toUpperCase()}`]?.trim() ||
      DEFAULT_HORIZON[n],
  );
  return { networkPassphrase, horizonUrl, networks };
}

/** The sponsor's ledgers — see `AppConfig.walletAuth.sponsor`. */
function sponsorLedgers() {
  const networkPassphrase =
    process.env.WALLET_RECOVERY_SPONSOR_NETWORK_PASSPHRASE?.trim() ||
    NETWORK_PASSPHRASE[stellarNetwork()];
  const horizonUrl = trimSlash(
    process.env.WALLET_RECOVERY_SPONSOR_HORIZON_URL?.trim() ||
      operatorHorizon()[stellarNetwork()],
  );
  const networks = ledgers(
    networkPassphrase,
    horizonUrl,
    networkList(process.env.WALLET_RECOVERY_SPONSOR_NETWORKS),
    (n) => operatorHorizon()[n],
  );
  return { networkPassphrase, horizonUrl, networks };
}

/** The Horizon each ledger's signers are read from for the wallet sign-in. */
function signersHorizons(): Record<StellarNetwork, string> {
  const horizons = operatorHorizon();
  const override = process.env.WALLET_AUTH_SIGNERS_HORIZON_URL?.trim();
  if (override) horizons[stellarNetwork()] = override;
  return {
    public: trimSlash(horizons.public),
    testnet: trimSlash(horizons.testnet),
  };
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
  apisixAdmin: {
    url: (process.env.APISIX_ADMIN_URL ?? '').trim().replace(/\/+$/, ''),
    key: process.env.APISIX_ADMIN_KEY?.trim() ?? '',
    timeoutMs: parseInt(
      process.env.APISIX_ADMIN_TIMEOUT_MS ??
        String(DEFAULT_APISIX_ADMIN_TIMEOUT_MS),
      10,
    ),
    walletSwapFeeBps: parseInt(
      process.env.WALLET_KEY_SWAP_FEE_BPS ??
        String(DEFAULT_WALLET_KEY_SWAP_FEE_BPS),
      10,
    ),
  },
  publicKeys: {
    dev: process.env.PUBLIC_API_KEY_DEV?.trim() ?? '',
    prod: process.env.PUBLIC_API_KEY_PROD?.trim() ?? '',
  },
  mail: {
    resendApiKey: process.env.MAIL_RESEND_API_KEY?.trim() ?? '',
    smtp: {
      host: process.env.MAIL_SMTP_HOST?.trim() ?? '',
      port: parseInt(
        process.env.MAIL_SMTP_PORT ?? String(DEFAULT_MAIL_SMTP_PORT),
        10,
      ),
      // 465 is implicit TLS; 587 upgrades with STARTTLS and wants `false`.
      secure:
        (process.env.MAIL_SMTP_SECURE ?? 'false').toLowerCase() === 'true',
      user: process.env.MAIL_SMTP_USER?.trim() ?? '',
      pass: process.env.MAIL_SMTP_PASS ?? '',
    },
    from: process.env.MAIL_FROM?.trim() ?? '',
    timeoutMs: parseInt(
      process.env.MAIL_TIMEOUT_MS ?? String(DEFAULT_MAIL_TIMEOUT_MS),
      10,
    ),
  },
  kyc: {
    redirectUrlWhitelist: parseRedirectUrlWhitelist(
      process.env.KYC_REDIRECT_URL_WHITELIST,
    ),
  },
  stellar: {
    network: stellarNetwork(),
    horizon: operatorHorizon(),
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
  solana: {
    rpcUrls: {
      public: process.env.SOLANA_RPC_URL_MAINNET ?? DEFAULT_SOLANA_RPC.public,
      testnet: process.env.SOLANA_RPC_URL_DEVNET ?? DEFAULT_SOLANA_RPC.testnet,
    },
    timeoutMs: parseInt(
      process.env.SOLANA_RPC_TIMEOUT_MS ?? String(DEFAULT_CHAIN_RPC_TIMEOUT_MS),
      10,
    ),
    swapFeeWallet: process.env.SOLANA_SWAP_FEE_WALLET?.trim() ?? '',
  },
  monad: {
    rpcUrls: {
      public: process.env.MONAD_RPC_URL_MAINNET ?? DEFAULT_MONAD_RPC.public,
      testnet: process.env.MONAD_RPC_URL_TESTNET ?? DEFAULT_MONAD_RPC.testnet,
    },
    timeoutMs: parseInt(
      process.env.MONAD_RPC_TIMEOUT_MS ?? String(DEFAULT_CHAIN_RPC_TIMEOUT_MS),
      10,
    ),
    logBlockRange: parseInt(
      process.env.MONAD_LOG_BLOCK_RANGE ??
        String(DEFAULT_MONAD_LOG_BLOCK_RANGE),
      10,
    ),
    relayerPrivateKey: process.env.MONAD_RELAYER_PRIVATE_KEY?.trim() ?? '',
    depositTokenFees: parseEvmTokenFees(process.env.MONAD_DEPOSIT_TOKEN_FEES),
    swapFeeWallet: process.env.MONAD_SWAP_FEE_WALLET?.trim() ?? '',
  },
  swapAggregators: {
    jupiter: {
      baseUrl: (
        process.env.JUPITER_BASE_URL ?? DEFAULT_JUPITER_BASE_URL
      ).replace(/\/+$/, ''),
      apiKey: process.env.JUPITER_API_KEY?.trim() ?? '',
      timeoutMs: parseInt(
        process.env.JUPITER_TIMEOUT_MS ??
          String(DEFAULT_SWAP_AGGREGATOR_TIMEOUT_MS),
        10,
      ),
    },
    kuru: {
      baseUrl: (process.env.KURU_BASE_URL ?? DEFAULT_KURU_BASE_URL).replace(
        /\/+$/,
        '',
      ),
      apiKey: process.env.KURU_API_KEY?.trim() ?? '',
      timeoutMs: parseInt(
        process.env.KURU_TIMEOUT_MS ??
          String(DEFAULT_SWAP_AGGREGATOR_TIMEOUT_MS),
        10,
      ),
    },
  },
  nearIntents: {
    baseUrl: (
      process.env.NEAR_INTENTS_BASE_URL ?? DEFAULT_NEAR_INTENTS_BASE_URL
    ).replace(/\/+$/, ''),
    apiKey: process.env.NEAR_INTENTS_API_KEY?.trim() ?? '',
    feeRecipient: process.env.NEAR_INTENTS_FEE_RECIPIENT?.trim() ?? '',
    timeoutMs: parseInt(
      process.env.NEAR_INTENTS_TIMEOUT_MS ??
        String(DEFAULT_NEAR_INTENTS_TIMEOUT_MS),
      10,
    ),
    slippageBps: parseInt(
      process.env.CROSS_CHAIN_SWAP_SLIPPAGE_BPS ??
        String(DEFAULT_CROSS_CHAIN_SLIPPAGE_BPS),
      10,
    ),
    maxSlippageBps: parseInt(
      process.env.CROSS_CHAIN_SWAP_MAX_SLIPPAGE_BPS ??
        String(DEFAULT_CROSS_CHAIN_MAX_SLIPPAGE_BPS),
      10,
    ),
    deadlineSeconds: parseInt(
      process.env.CROSS_CHAIN_SWAP_DEADLINE_SECONDS ??
        String(DEFAULT_CROSS_CHAIN_DEADLINE_SECONDS),
      10,
    ),
  },
  observer: {
    // Permanent reconciler that watches every chain and finalizes paid intents.
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
    enabled: parsePluginsEnabled(process.env).filter(
      (slug) => !isNativePluginSlug(slug),
    ),
    native: parsePluginsEnabled(process.env).filter(isNativePluginSlug),
    secret: process.env.PLUGINS_SECRET?.trim() ?? '',
    trustedKeys: process.env.PLUGINS_TRUSTED_KEYS?.trim() ?? '',
    allowUnsigned:
      (process.env.PLUGINS_ALLOW_UNSIGNED ?? 'false').toLowerCase() === 'true',
    nodeSnapshotDisabled:
      process.execArgv.includes('--no-node-snapshot') ||
      (process.env.NODE_OPTIONS ?? '').includes('--no-node-snapshot'),
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
    // Validated at boot by `identity-env.ts`; malformed keys never reach here.
    backupKeyring: keyringFrom(
      process.env.WALLET_BACKUP_ENCRYPTION_KEY ?? '',
      process.env.WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS ?? '',
    ),
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
    // One Horizon per ledger, and the request picks which ledger — never a URL.
    // A re-key lands on ONE ledger, so a recovered wallet's key signs for its
    // account there and nowhere else; reading only `STELLAR_NETWORK`'s ledger
    // failed every wallet recovered on the other one with
    // `wallet_signature_invalid`. What the request cannot do is make a key count
    // on a ledger where it is not a signer: each check reads ONE ledger.
    signersHorizonUrls: signersHorizons(),
    signersNetwork: stellarNetwork(),
    sponsor: {
      secret: process.env.WALLET_RECOVERY_SPONSOR_SECRET?.trim() ?? '',
      ...sponsorLedgers(),
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
    ...recoveryLedgers(),
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
    emailCodes:
      (process.env.RECOVERY_EMAIL_CODES ?? 'false').toLowerCase() === 'true',
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
