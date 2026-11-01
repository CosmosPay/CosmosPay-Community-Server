import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

export const PERMISSIONS_KEY = 'requiredPermissions';
export const ANY_PERMISSIONS_KEY = 'requiredAnyPermissions';

/**
 * Vendor extensions the published spec carries: the scopes the API key must
 * hold, "all of" and "one of", exactly as `PermissionsGuard` reads them.
 * `swagger.ts` turns them into the last sentence of each operation's
 * description. Published from the decorator, not written by hand in each
 * description, so the contract cannot name a scope the guard does not check.
 */
export const SCOPES_EXTENSION_KEY = 'x-cosmos-scopes';
export const ANY_SCOPES_EXTENSION_KEY = 'x-cosmos-scopes-any';

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
  applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    ApiExtension(SCOPES_EXTENSION_KEY, permissions),
  );

/**
 * Declares that the key must hold **at least one** of the given scopes ("any
 * of"). Used where two scope families both grant access — e.g. liquidity pool
 * endpoints accept `liquidity:*` or, for backwards compatibility, `swaps:*`.
 * Combines with @RequirePermissions: all of the "all of" set AND one of this set.
 *
 *   @RequireAnyPermission('liquidity:write', 'swaps:write')
 */
export const RequireAnyPermission = (...permissions: string[]) =>
  applyDecorators(
    SetMetadata(ANY_PERMISSIONS_KEY, permissions),
    ApiExtension(ANY_SCOPES_EXTENSION_KEY, permissions),
  );
