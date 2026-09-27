import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Vendor extension the published spec carries, and `swagger.ts` reads back to
 * decide what a route can fail with.
 */
export const PUBLIC_EXTENSION_KEY = 'x-cosmos-public';

/**
 * Marks a route as reachable without passing the APISIX gateway check.
 * Use sparingly — e.g. liveness/readiness probes hit by the orchestrator,
 * not by clients coming through the gateway.
 *
 * It documents itself as well as enforcing itself: the operation is published
 * with `security: []` and without the 401/403 every other route carries, since
 * no guard on this route can return either. The spec used to say `/v1/health/
 * liveness` could answer `no_authenticated_consumer` — an endpoint whose whole
 * purpose is to answer an orchestrator that sends no credentials at all.
 */
export const Public = () =>
  applyDecorators(
    SetMetadata(IS_PUBLIC_KEY, true),
    ApiExtension(PUBLIC_EXTENSION_KEY, true),
  );
