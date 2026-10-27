import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';

/**
 * Whether a consumer is the SHARED public API key: every anonymous wallet and
 * public page arrives as this one consumer.
 *
 * Two independent signals, and EITHER one is enough, because each alone fails
 * open in a way that costs user data: the role APISIX forwards
 * (`X-Consumer-Role: public`), and the configured consumer username
 * (`APISIX_PUBLIC_CONSUMER`). A gateway that stops forwarding roles is caught by
 * the name; a deployment that never set the name is caught by the role.
 *
 * `PublicKeyGuard` confines this consumer to `@AllowPublicKey()` routes, and
 * `PublicRecordTokens` asks it for a record's token: both decide with this one
 * predicate, so the two can never disagree about who the public key is.
 */
export function isSharedPublicKey(
  consumer: Pick<GatewayConsumer, 'username' | 'role'>,
  publicConsumer: string,
): boolean {
  if (consumer.role === 'public') return true;
  return !!publicConsumer && consumer.username === publicConsumer;
}
