import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';

/**
 * Whether the caller may act as the platform rather than as its tenant.
 *
 * There is exactly one notion of privilege in this service and this is it: the role
 * APISIX forwards from the consumer's own metadata (`X-Consumer-Role`), which
 * `PermissionsGuard` already treats as full access. The platform-admin surface
 * (`/v1/admin`, `AdminGuard` + a platform-console call) is the other, stronger identity
 * and has its own audited variants of the KYC operations — see
 * `ReceiversService.approveById`.
 *
 * A plain tenant key is NOT elevated. A `kyc:write` key belongs to the tenant whose KYC
 * data is under review, so it can neither sign off on that review nor lift an
 * operator's kill-switch; a `pollar:write` key cannot write to the Pollar user
 * directory every tenant shares.
 */
export function isElevatedConsumer(consumer: GatewayConsumer): boolean {
  return consumer.role === 'admin';
}
