import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'requiredPermissions';
export const ANY_PERMISSIONS_KEY = 'requiredAnyPermissions';

/**
 * Declares the API-key scopes a handler (or controller) requires. Enforced by
 * PermissionsGuard against the permissions forwarded by APISIX
 * (X-Consumer-Permissions). `admin` keys bypass the check.
 *
 *   @RequirePermissions('write')
 *   create(...) { ... }
 *
 * Multiple scopes are treated as "all of" (the key must hold every one).
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Declares that the key must hold **at least one** of the given scopes ("any
 * of"). Used where two scope families both grant access — e.g. liquidity pool
 * endpoints accept `liquidity:*` or, for backwards compatibility, `swaps:*`.
 * Combines with @RequirePermissions: all of the "all of" set AND one of this set.
 *
 *   @RequireAnyPermission('liquidity:write', 'swaps:write')
 */
export const RequireAnyPermission = (...permissions: string[]) =>
  SetMetadata(ANY_PERMISSIONS_KEY, permissions);
