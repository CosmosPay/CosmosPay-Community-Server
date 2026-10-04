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
 * Version tag of the console marker's wire format: `v1.<unix seconds>.<hex mac>`.
 * A new format gets a new tag, so an old console is refused rather than misread.
 */
export const CONSOLE_MARKER_VERSION = 'v1';

/**
 * Domain-separation prefix for the marker's HMAC. The key is the gateway secret,
 * which signs nothing else in this service today; the label keeps it that way if
 * something else ever derives from the same key. The dev platform holds its own
 * copy of this literal — `console-marker.spec.ts` pins a shared test vector.
 */
export const CONSOLE_MARKER_LABEL = 'cosmos-admin-console:v1:';

/**
 * How far a marker's timestamp may sit from this server's clock, either way.
 * The console mints a fresh marker per request, so this only has to absorb clock
 * skew between two servers; it is what stops a marker copied out of a log from
 * being a standing admin credential.
 */
export const CONSOLE_MARKER_MAX_SKEW_S = 300;
