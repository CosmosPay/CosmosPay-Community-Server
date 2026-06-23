/**
 * Centralized, typed configuration loaded from environment variables.
 * Consumed via Nest's ConfigService<AppConfig, true>.
 */
export type StellarNetwork = 'public' | 'testnet';

export interface AppConfig {
  nodeEnv: string;
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
    enforce: boolean;
  };
  stellar: {
    // Fallback network when the API key environment is not forwarded
    // (e.g. local dev without the gateway). Otherwise the key type decides.
    network: StellarNetwork;
    horizon: Record<StellarNetwork, string>;
    baseFee: string;
    timeoutSeconds: number;
  };
  observer: {
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
  };
  webhooks: {
    timeoutMs: number;
    maxAttempts: number;
    backoffMs: number;
    signatureHeader: string;
  };
}

const DEFAULT_HORIZON: Record<StellarNetwork, string> = {
  public: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org',
};

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
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
    enforce: (process.env.ENFORCE_GATEWAY ?? 'true').toLowerCase() !== 'false',
  },
  stellar: {
    network:
      (process.env.STELLAR_NETWORK ?? 'testnet').toLowerCase() === 'public'
        ? 'public'
        : 'testnet',
    horizon: {
      public:
        process.env.STELLAR_HORIZON_URL_PUBLIC ?? DEFAULT_HORIZON.public,
      testnet:
        process.env.STELLAR_HORIZON_URL_TESTNET ?? DEFAULT_HORIZON.testnet,
    },
    baseFee: process.env.STELLAR_BASE_FEE ?? '100',
    timeoutSeconds: parseInt(process.env.STELLAR_TX_TIMEOUT ?? '300', 10),
  },
  observer: {
    // Permanent reconciler that watches Stellar and finalizes paid intents.
    enabled: (process.env.OBSERVER_ENABLED ?? 'true').toLowerCase() !== 'false',
    intervalMs: parseInt(process.env.OBSERVER_INTERVAL_MS ?? '15000', 10),
    batchSize: parseInt(process.env.OBSERVER_BATCH_SIZE ?? '50', 10),
  },
  webhooks: {
    timeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS ?? '5000', 10),
    maxAttempts: parseInt(process.env.WEBHOOK_MAX_ATTEMPTS ?? '3', 10),
    backoffMs: parseInt(process.env.WEBHOOK_BACKOFF_MS ?? '2000', 10),
    signatureHeader: (
      process.env.WEBHOOK_SIGNATURE_HEADER ?? 'x-cosmos-signature'
    ).toLowerCase(),
  },
});
