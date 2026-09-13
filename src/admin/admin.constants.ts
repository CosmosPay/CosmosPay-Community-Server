/**
 * Tunables for the platform-admin (owner) surface.
 *
 * The gate used to be a second, separately-deployed shared secret
 * (`ADMIN_API_CREDENTIALS`). It is gone: who is a platform admin is decided in
 * ONE place — the developer platform, against the signed-in account's role —
 * exactly as it already is for changing another account's plan or role. This
 * service only recognises that the call came from that console.
 */

/**
 * Marks a call as coming from the platform console rather than from an API key.
 *
 * APISIX removes any client-supplied copy on every route it serves (see
 * `proxy-rewrite.headers.remove` in the dev platform's `createRoute`), so a
 * request that still carries it did not come through the data plane — it came
 * from a backend that holds `APISIX_GATEWAY_SECRET`, which `ApisixGuard` has
 * already verified by the time the admin gate runs.
 */
export const ADMIN_INTERNAL_HEADER = 'x-cosmos-internal';

/**
 * The signed-in console account's platform role (`owner` / `admin`), forwarded
 * for the audit trail. It grants nothing — the console has already enforced it —
 * so a missing or unknown value costs the row a label, not the request.
 */
export const ADMIN_ACTOR_ROLE_HEADER = 'x-cosmos-admin-role';

/** Roles the console can assert. Anything else is recorded as the default. */
export const ADMIN_ACTOR_ROLES = ['owner', 'admin', 'support'] as const;

/**
 * Audit fallbacks for a call with no console identity — an operator's own
 * server-to-server call, say. Written rather than rejected so the row still
 * names something; `actorId` normally holds the consumer username
 * (`cosmos_<userId>`) of the admin who acted.
 */
export const DEFAULT_ADMIN_ACTOR_ID = 'internal';
export const DEFAULT_ADMIN_ACTOR_ROLE = 'internal';

/**
 * Values of {@link ADMIN_INTERNAL_HEADER} that do NOT mark an internal call, so
 * a console that forwards `0` / `false` for "not internal" is taken at its word
 * instead of being read as "any value present ⇒ admin".
 */
export const ADMIN_INTERNAL_FALSY = ['0', 'false', 'no', 'off'] as const;
