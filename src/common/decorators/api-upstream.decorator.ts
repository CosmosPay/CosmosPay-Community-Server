import { ApiExtension } from '@nestjs/swagger';

/** The providers this service calls out to while serving a request. */
export type UpstreamProvider = 'BlindPay' | 'Horizon' | 'Pollar';

/**
 * Vendor extension the published spec carries, and `swagger.ts` reads back.
 * Named, not inlined, because two files have to agree on the spelling.
 */
export const UPSTREAM_EXTENSION_KEY = 'x-cosmos-upstream';

/**
 * Declares that serving this route means calling a third party, so it can fail
 * for a reason the caller's request is not responsible for.
 *
 *   @ApiUpstream('BlindPay')
 *   @Controller({ path: 'offramp', version: '1' })
 *
 * `swagger.ts` turns it into the 502/503/504 responses, naming the provider.
 * Without it those statuses are not documented — which is the point. The spec
 * used to attach "an upstream provider returned an error" to every operation,
 * including `GET /v1/products`, which reads one table and calls nobody. A
 * status a route cannot return is not documentation, it is noise an integrator
 * writes a handler for.
 *
 * Put it on the controller when every route it serves reaches the provider, or
 * on the handler when only some do (`PATCH /v1/payment-intents/{id}` verifies a
 * tx hash against Horizon; `GET /v1/payment-intents` does not).
 */
export const ApiUpstream = (...providers: UpstreamProvider[]) =>
  ApiExtension(UPSTREAM_EXTENSION_KEY, providers);
