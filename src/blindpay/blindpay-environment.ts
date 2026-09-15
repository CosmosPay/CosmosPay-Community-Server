import { ConfigService } from '@nestjs/config';
import type { AppConfig, BlindpayEnvironment } from '@/config/configuration';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { resolveNetwork } from '@/common/stellar-network';

/**
 * The BlindPay instance a caller is scoped to: the production instance for a
 * `prod` key, the development instance for a `dev` key.
 *
 * Derived from {@link resolveNetwork} rather than read off the header directly,
 * so the fallback when the gateway forwards no environment (local dev without
 * APISIX) is the same configured Stellar network every other module uses. A
 * caller's fiat rows and its Stellar rows then never disagree about which world
 * they are in: testnet pairs with the development instance, mainnet with
 * production.
 */
export function resolveBlindpayEnvironment(
  config: ConfigService<AppConfig, true>,
  consumer: GatewayConsumer,
): BlindpayEnvironment {
  return resolveNetwork(config, consumer) === 'public' ? 'prod' : 'dev';
}

/**
 * The environment a stored mirror row names, for work that starts from the row
 * rather than from a caller — an admin approving or enabling a receiver acts on
 * whichever instance the receiver lives on.
 *
 * The column is a plain string, so it is narrowed here. Anything other than the
 * two values this service writes is refused instead of guessed: a wrong guess
 * sends the call to the other instance.
 */
export function storedBlindpayEnvironment(value: string): BlindpayEnvironment {
  if (value === 'dev' || value === 'prod') return value;
  throw new Error(`Unknown BlindPay environment on a stored row: '${value}'`);
}
