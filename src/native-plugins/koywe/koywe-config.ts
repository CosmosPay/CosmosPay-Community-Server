import type {
  AppConfig,
  KoyweEnvironmentConfig,
  StellarNetwork,
} from '@/config/configuration';
import {
  KOYWE_NETWORK_TOKENS,
  type KoyweNetwork,
  type KoyweToken,
} from '@/native-plugins/koywe/koywe.constants';

type KoyweConfig = AppConfig['koywe'];

const NETWORKS: readonly StellarNetwork[] = ['public', 'testnet'];

/**
 * Whether one provider environment can serve bank transfers at all: it can
 * sign in (key and secret), act in Cosmos Pay's organization and tell its
 * webhooks from forgeries. The merchant id is not part of it: sellers have
 * their own, and Cosmos Pay's is needed only in pooled mode.
 */
export function isKoyweEnvironmentComplete(
  environment: KoyweEnvironmentConfig,
): boolean {
  return Boolean(
    environment.apiKey &&
    environment.secret &&
    environment.organizationId &&
    environment.webhookSecret,
  );
}

/** The networks bank transfers are served on: a complete environment, and the pepper the payer's document is hashed under. */
export function railNetworks(config: KoyweConfig): StellarNetwork[] {
  if (!config.documentPepper) return [];
  return NETWORKS.filter((network) =>
    isKoyweEnvironmentComplete(config.environments[network]),
  );
}

/**
 * Cosmos Pay's own merchant on `network`, when pooled mode is on and it is
 * configured there: it takes the requests of sellers without an account.
 */
export function pooledMerchantId(
  config: KoyweConfig,
  network: StellarNetwork,
): string | null {
  const environment = config.environments[network];
  return config.pooledEnabled &&
    environment.merchantId &&
    railNetworks(config).includes(network)
    ? environment.merchantId
    : null;
}

/** Whether the provider delivers `token` on `network` through an ONRAMP. */
export function koyweDelivers(network: string, token: string): boolean {
  return (
    KOYWE_NETWORK_TOKENS[network as KoyweNetwork]?.includes(
      token as KoyweToken,
    ) ?? false
  );
}

/**
 * Checked when the plugin boots, so a deployment that does not enable it is
 * not held to variables it never reads. Throws on a configuration that cannot
 * work (the plugin that owns payment requests is off, one secret would verify
 * both networks' webhooks, a sandbox pair the provider does not serve, bounds
 * the wrong way round); answers what merely leaves the rail off, for the boot
 * log.
 */
export function assertKoyweConfigConsistent(
  config: KoyweConfig,
  nativePlugins: readonly string[],
): string[] {
  if (!nativePlugins.includes('eldorado')) {
    throw new Error(
      'PLUGINS_ENABLED lists koywe without eldorado: bank transfers pay the payment ' +
        'requests the eldorado plugin owns. Enable both, or neither.',
    );
  }
  const { public: production, testnet: sandbox } = config.environments;
  if (
    production.webhookSecret &&
    production.webhookSecret === sandbox.webhookSecret
  ) {
    throw new Error(
      'KOYWE_WEBHOOK_SECRET and KOYWE_SANDBOX_WEBHOOK_SECRET are the same: the secret ' +
        'that verifies a delivery decides which network it may change. Register each ' +
        'environment with its own.',
    );
  }
  if (!koyweDelivers(config.sandboxNetwork, config.sandboxToken)) {
    throw new Error(
      `KOYWE_SANDBOX_NETWORK=${config.sandboxNetwork} with KOYWE_SANDBOX_TOKEN=${config.sandboxToken} ` +
        'is not a pair the provider converts to. Pick one of: ' +
        Object.entries(KOYWE_NETWORK_TOKENS)
          .map(([network, tokens]) => `${network} (${tokens.join(', ')})`)
          .join('; '),
    );
  }
  if (
    !(config.minArs > 0) ||
    !(config.maxArs > 0) ||
    config.minArs > config.maxArs
  ) {
    throw new Error(
      `KOYWE_MIN_ARS (${config.minArs}) must be positive and no more than KOYWE_MAX_ARS (${config.maxArs}).`,
    );
  }

  const notes: string[] = [];
  const configured = NETWORKS.filter((network) => {
    const environment = config.environments[network];
    return Boolean(
      environment.apiKey ||
      environment.secret ||
      environment.organizationId ||
      environment.webhookSecret,
    );
  });
  for (const network of configured) {
    if (!isKoyweEnvironmentComplete(config.environments[network])) {
      notes.push(
        `${prefixOf(network)}API_KEY, SECRET, ORGANIZATION_ID and WEBHOOK_SECRET are not all set: ` +
          `no bank transfer on ${network}.`,
      );
    }
  }
  if (configured.length > 0 && !config.documentPepper) {
    notes.push(
      'KOYWE_DOCUMENT_PEPPER is not set: no bank transfer is offered (the payer’s ' +
        'document is stored only as an HMAC under it).',
    );
  }
  if (config.pooledEnabled) {
    for (const network of railNetworks(config)) {
      if (!config.environments[network].merchantId) {
        notes.push(
          `KOYWE_POOLED_ENABLED is on but ${prefixOf(network)}MERCHANT_ID is not set: ` +
            `no pooled bank transfer on ${network}.`,
        );
      }
    }
  }
  return notes;
}

/** The env var prefix of a network's environment. */
export function prefixOf(network: StellarNetwork): string {
  return network === 'public' ? 'KOYWE_' : 'KOYWE_SANDBOX_';
}
