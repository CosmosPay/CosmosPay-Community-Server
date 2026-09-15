/**
 * Expected Pollar API key prefixes per key type and network, checked at boot by
 * `env.validation.ts`.
 *
 * Pollar stamps both into the key itself (`pub_mainnet_`, `sec_testnet_`), so a
 * testnet key pasted into the mainnet variable — or a secret key into the
 * publishable one — is caught before the first handshake fails at the provider.
 *
 * It lives in `config/` because boot validation is its only reader: the config
 * layer is imported by every feature module, and importing a feature module's
 * constants back into it inverted that dependency.
 */
export const POLLAR_KEY_PREFIX = {
  publishable: { public: 'pub_mainnet_', testnet: 'pub_testnet_' },
  secret: { public: 'sec_mainnet_', testnet: 'sec_testnet_' },
} as const;
