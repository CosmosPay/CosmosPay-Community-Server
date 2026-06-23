import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'requiredPermissions';

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
