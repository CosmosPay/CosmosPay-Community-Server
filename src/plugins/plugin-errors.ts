/**
 * Failures the runtime raises INSIDE a plugin invocation, as distinct from the
 * `PluginError` a plugin throws on purpose (`@/plugins/sdk`).
 *
 * The runtime maps them to responses in one place (`PluginRuntimeService`):
 * a quota is the tenant's problem and says so (409); every other one is the
 * plugin overstepping, which the caller cannot fix and must not be told the
 * detail of (502, logged).
 */

/** The installation is at its record cap. */
export class PluginQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginQuotaError';
  }
}

/**
 * The plugin reached for something it was not granted: a capability it did not
 * declare or the tenant did not consent to, a host outside its egress list, a
 * private address, too many context calls, or its context after it was revoked.
 */
export class PluginViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginViolationError';
  }
}

/** The invocation ran out of wall-clock time. */
export class PluginTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginTimeoutError';
  }
}
