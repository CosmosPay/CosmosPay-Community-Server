/**
 * Cache lifetimes for OpenID Connect discovery and key sets (`oidc.service.ts`).
 */

/** A provider's endpoints change on a redeploy, not between two requests. */
export const OIDC_DISCOVERY_TTL_MS = 60 * 60 * 1000;

/**
 * How long a key set is trusted before it is fetched again. Short enough that a
 * key the provider revoked stops verifying within minutes; a rotation ADDING a
 * key is picked up sooner, on the first token that names it.
 */
export const OIDC_JWKS_TTL_MS = 10 * 60 * 1000;

/**
 * The fastest an unknown `kid` may force a refetch. A token's header is the
 * caller's to write, so without this every request carrying an invented key id
 * would be a request this service forwards to the provider.
 */
export const OIDC_JWKS_REFRESH_MIN_MS = 60 * 1000;
