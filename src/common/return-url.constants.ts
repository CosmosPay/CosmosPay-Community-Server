/**
 * Policy for the app return URLs a sign-in may redirect to — see
 * `@/common/return-url`.
 */

/**
 * Schemes a return URL may never use, whatever the operator listed. Each one
 * either runs in the page that follows the redirect or reads the local disk, and
 * none of them is how an app receives a sign-in.
 */
export const FORBIDDEN_RETURN_SCHEMES: ReadonlySet<string> = new Set([
  'javascript:',
  'data:',
  'file:',
  'blob:',
  'vbscript:',
  'about:',
]);

/**
 * RFC 8252 §7.3 loopback hosts. A desktop app binds an ephemeral port at sign-in
 * time, so an allowlist entry on one of these matches ANY port. `localhost` is
 * left out on purpose: §8.3 recommends the literal, since a name can resolve
 * somewhere else.
 */
export const LOOPBACK_RETURN_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '[::1]',
]);
