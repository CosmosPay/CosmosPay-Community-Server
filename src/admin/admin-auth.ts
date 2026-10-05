import {
  ADMIN_ACTOR_ROLES,
  DEFAULT_ADMIN_ACTOR_ID,
  DEFAULT_ADMIN_ACTOR_ROLE,
} from '@/admin/admin.constants';
import { verifyConsoleMarker } from '@/admin/console-marker';

/**
 * Executable spec for platform-admin auth.
 *
 * There is no admin credential in this service any more. `ADMIN_API_CREDENTIALS`
 * was a second secret that had to be deployed, matched and rotated alongside the
 * gateway secret, and every deployment that skipped it got the same broken
 * split: an owner could change another account's plan and role in the console —
 * which never asked for it — yet every cross-tenant READ answered 401 "Valid
 * admin credentials required" while their platform rights were perfectly fine.
 * Nothing in that error pointed at a missing deployment secret.
 *
 * So the question this module answers changed. It is no longer "does the caller
 * hold the admin secret?" but "did this call come from the platform console?" —
 * the console being the one place that already knows who is an owner/admin, and
 * already gates the plan/role screens on it. Two facts establish that, and both
 * are checked before a handler runs:
 *
 *   1. `ApisixGuard` (global) verified `X-Gateway-Secret`. Only the gateway and
 *      the console backend hold it.
 *   2. The internal marker below is a fresh MAC keyed by that same secret (see
 *      `console-marker.ts`). APISIX also strips the header from every request it
 *      proxies, but that is defence in depth now, not the proof: an API-key
 *      caller holds no gateway secret, so even a route that forgets the strip
 *      forwards a marker nobody outside could have minted.
 *
 * Both facts rest on the one secret the service already holds, so there is
 * still no second credential to deploy, and still a single source of truth for
 * "who is a platform admin" instead of two that silently disagree. The audit trail is what makes it
 * answerable after the fact — every read and every mutation records the console
 * account that made it (see `AdminAuditService`).
 */
export interface AdminPrincipal {
  /** Stable actor id recorded on audit rows — the console account's consumer username. */
  id: string;
  /** The console account's platform role, for the audit row only. Grants nothing. */
  role: string;
}

/** The request facts the admin gate reads. Pure — no Nest, no request object. */
export interface AdminCallContext {
  /** Raw `X-Cosmos-Internal` header value. */
  internal?: string | string[];
  /** The gateway secret the marker must be keyed with. Empty fails closed. */
  gatewaySecret: string;
  /** Clock for the marker's freshness window; `Date.now()` outside tests. */
  nowMs?: number;
  /** Raw `X-Cosmos-Admin-Role` header value. */
  actorRole?: string | string[];
  /** `X-Consumer-Username` as normalized by ApisixContextMiddleware. */
  consumer?: string;
}

/**
 * Resolve the admin principal for a call, or null when it is not an internal
 * platform-console call. Callers MUST have verified the gateway secret first —
 * this function assumes it and does not re-check it.
 */
export function resolveAdminPrincipal(
  ctx: AdminCallContext,
): AdminPrincipal | null {
  if (!isInternalCall(ctx.internal, ctx.gatewaySecret, ctx.nowMs)) return null;
  return {
    id: firstHeader(ctx.consumer) ?? DEFAULT_ADMIN_ACTOR_ID,
    role: normalizeActorRole(ctx.actorRole),
  };
}

/**
 * Whether the request carries a valid platform-console marker: a MAC minted with
 * the gateway secret inside the freshness window. The bare `1` the console used
 * to send is refused like any other forgery.
 */
export function isInternalCall(
  raw: string | string[] | undefined,
  gatewaySecret: string,
  nowMs: number = Date.now(),
): boolean {
  return verifyConsoleMarker(firstHeader(raw), gatewaySecret, nowMs);
}

/** Console role → audit label. Unknown/absent collapses to the default label. */
function normalizeActorRole(raw?: string | string[]): string {
  const value = firstHeader(raw)?.toLowerCase();
  return value &&
    ADMIN_ACTOR_ROLES.includes(value as (typeof ADMIN_ACTOR_ROLES)[number])
    ? value
    : DEFAULT_ADMIN_ACTOR_ROLE;
}

/** Header values arrive as `string | string[]`; collapse to a trimmed string. */
function firstHeader(raw?: string | string[]): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
