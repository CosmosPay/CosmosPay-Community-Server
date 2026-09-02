import { ConfigService } from '@nestjs/config';
import { AppConfig, StellarNetwork } from '../config/configuration';
import { GatewayConsumer } from './interfaces/gateway-consumer.interface';

/**
 * The Stellar network a caller is scoped to, derived from the API key's
 * environment that APISIX forwards: `prod` → public, `dev` → testnet, and the
 * configured default when the gateway forwards nothing (local dev without
 * APISIX in front).
 *
 * Every service that reads or writes a network-scoped row must agree on this,
 * or the reader looks at a different network than the writer wrote to. It was
 * previously a private copy in each of payment-intents, swaps and
 * liquidity-pools — and a *fourth*, divergent one in analytics that omitted the
 * configured-default fallback. With no environment header the three writers
 * used the configured network while the dashboard queried `testnet`, so every
 * metric read empty.
 */
export function resolveNetwork(
  config: ConfigService<AppConfig, true>,
  consumer: GatewayConsumer,
): StellarNetwork {
  if (consumer.environment === 'prod') return 'public';
  if (consumer.environment === 'dev') return 'testnet';
  return config.get('stellar', { infer: true }).network;
}
