import { SetMetadata } from '@nestjs/common';

export const ALLOW_PUBLIC_KEY = 'allowPublicKey';

/**
 * Marks a handler as reachable by the SHARED public API key.
 *
 * The public key is one credential embedded in every copy of an open-source
 * wallet, so every anonymous caller on the planet arrives as the same APISIX
 * consumer. Scopes cannot separate them from each other — a scope is a property
 * of the key, and they all hold the same key — so any endpoint that returns rows
 * filtered by `consumer.apisixUsername` would hand each anonymous user the whole
 * anonymous population's history. `GET /v1/swaps` is the concrete case: it is
 * guarded by `swaps:read`, which the public key must also hold in order to reach
 * `POST /v1/swaps/quote`. One scope, two very different exposures.
 *
 * Hence an allowlist and not a denylist. `PublicKeyGuard` refuses a public
 * consumer on every route that does not carry this decorator, so a route added
 * later is unreachable by the public key until someone states otherwise in the
 * same diff. The failure mode of forgetting it is an anonymous user seeing
 * "not available without an account", which is a support ticket; the failure mode
 * of forgetting a denylist entry is a data leak, which is not.
 *
 * Put it only on handlers whose response is a pure function of the request —
 * a quote, a built envelope, a public catalog, on-chain pool data. Never on one
 * that reads back what this consumer previously wrote.
 *
 *   @Post('quote')
 *   @AllowPublicKey()
 *   @RequirePermissions('swaps:read')
 *   quote(...) { ... }
 */
export const AllowPublicKey = () => SetMetadata(ALLOW_PUBLIC_KEY, true);
