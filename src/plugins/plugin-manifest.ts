import {
  PLUGIN_ACTION_RE,
  PLUGIN_CONFIG_FIELD_RE,
  PLUGIN_EGRESS_HOST_RE,
  PLUGIN_SLUG_RE,
  PLUGIN_VERSION_RE,
} from '@/plugins/plugins.constants';
import {
  PLUGIN_CAPABILITIES,
  PLUGIN_EVENT_TYPES,
  type PluginCapability,
  type PluginConfigValue,
  type PluginDefinition,
} from '@/plugins/sdk';

/** Which capability each event subscription reads through. */
export const PLUGIN_EVENT_CAPABILITY: PluginCapability = 'payment_intents:read';

/**
 * Every reason `definition` cannot be loaded. Empty means valid.
 *
 * A pure function over the manifest, so the whole rule set is testable without a
 * Nest container, and the registry refuses to boot on a non-empty answer: a
 * plugin whose manifest lies about what it does is never half-loaded.
 */
export function validatePluginDefinition(
  definition: PluginDefinition,
): string[] {
  const errors: string[] = [];
  const at = `plugin "${String(definition.slug)}"`;

  if (!PLUGIN_SLUG_RE.test(definition.slug ?? '')) {
    errors.push(`${at}: slug must match ${PLUGIN_SLUG_RE}`);
  }
  if (!PLUGIN_VERSION_RE.test(definition.version ?? '')) {
    errors.push(`${at}: version must be semver (MAJOR.MINOR.PATCH)`);
  }
  for (const field of ['name', 'description', 'author'] as const) {
    const value = definition[field];
    if (
      typeof value !== 'string' ||
      value.trim() === '' ||
      value.length > 500
    ) {
      errors.push(`${at}: ${field} must be a non-empty string (≤ 500 chars)`);
    }
  }

  const capabilities = definition.capabilities ?? [];
  const known = new Set<string>(PLUGIN_CAPABILITIES);
  for (const capability of capabilities) {
    if (!known.has(capability)) {
      errors.push(`${at}: unknown capability "${capability}"`);
    }
  }
  if (new Set(capabilities).size !== capabilities.length) {
    errors.push(`${at}: capabilities are listed twice`);
  }

  for (const host of definition.egress ?? []) {
    if (!PLUGIN_EGRESS_HOST_RE.test(host)) {
      errors.push(
        `${at}: egress host "${host}" must be a lowercase DNS name — no scheme, port, IP or wildcard`,
      );
    }
  }

  for (const [name, field] of Object.entries(definition.config ?? {})) {
    if (!PLUGIN_CONFIG_FIELD_RE.test(name)) {
      errors.push(
        `${at}: config field "${name}" must match ${PLUGIN_CONFIG_FIELD_RE}`,
      );
    }
    if (!['string', 'number', 'boolean'].includes(field.type)) {
      errors.push(`${at}: config field "${name}" has an unknown type`);
    }
    if (field.secret && field.type !== 'string') {
      errors.push(
        `${at}: config field "${name}" is secret, so it must be a string`,
      );
    }
  }

  const queries = Object.keys(definition.queries ?? {});
  const commands = Object.keys(definition.commands ?? {});
  for (const action of [...queries, ...commands]) {
    if (!PLUGIN_ACTION_RE.test(action)) {
      errors.push(`${at}: action "${action}" must match ${PLUGIN_ACTION_RE}`);
    }
  }
  for (const action of queries.filter((q) => commands.includes(q))) {
    errors.push(`${at}: "${action}" is both a query and a command`);
  }
  for (const [action, handler] of [
    ...Object.entries(definition.queries ?? {}),
    ...Object.entries(definition.commands ?? {}),
  ]) {
    if (typeof handler !== 'function') {
      errors.push(`${at}: action "${action}" has no handler function`);
    }
  }

  const events = new Set<string>(PLUGIN_EVENT_TYPES);
  for (const [type, handler] of Object.entries(definition.events ?? {})) {
    if (!events.has(type)) {
      errors.push(`${at}: cannot subscribe to "${type}"`);
    }
    if (typeof handler !== 'function') {
      errors.push(`${at}: event "${type}" has no handler function`);
    }
    if (!capabilities.includes(PLUGIN_EVENT_CAPABILITY)) {
      errors.push(
        `${at}: subscribing to "${type}" needs the "${PLUGIN_EVENT_CAPABILITY}" capability`,
      );
    }
  }

  return errors;
}

/** True when the manifest declares at least one secret config field. */
export function hasSecretConfig(definition: PluginDefinition): boolean {
  return Object.values(definition.config ?? {}).some((f) => f.secret);
}

export interface ParsedPluginConfig {
  /** Stored in the clear, returned to the tenant. */
  plain: Record<string, PluginConfigValue>;
  /** Sealed at rest, never returned. */
  secret: Record<string, string>;
}

/**
 * Checks a tenant's config against the manifest and splits it into its plain and
 * secret halves. Returns the problems instead when there are any.
 *
 * Unknown fields are refused rather than dropped: a typo in a field name that is
 * silently ignored is a plugin that runs without the setting its tenant thinks
 * it has.
 */
export function parsePluginConfig(
  definition: PluginDefinition,
  raw: Record<string, unknown>,
): { ok: true; value: ParsedPluginConfig } | { ok: false; errors: string[] } {
  const fields = definition.config ?? {};
  const errors: string[] = [];
  const value: ParsedPluginConfig = { plain: {}, secret: {} };

  for (const name of Object.keys(raw)) {
    if (!Object.hasOwn(fields, name)) {
      errors.push(`config.${name} is not a setting of this plugin`);
    }
  }

  for (const [name, field] of Object.entries(fields)) {
    const given = raw[name];
    if (given === undefined || given === null || given === '') {
      if (field.required) errors.push(`config.${name} is required`);
      continue;
    }
    if (typeof given !== field.type) {
      errors.push(`config.${name} must be a ${field.type}`);
      continue;
    }
    if (typeof given === 'string' && given.length > 2000) {
      errors.push(`config.${name} must be at most 2000 characters`);
      continue;
    }
    if (typeof given === 'number' && !Number.isFinite(given)) {
      errors.push(`config.${name} must be a finite number`);
      continue;
    }
    if (field.secret) {
      value.secret[name] = given as string;
    } else {
      value.plain[name] = given as PluginConfigValue;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/**
 * The capabilities the tenant granted that the plugin still declares — and
 * whether that covers everything the current version asks for.
 *
 * A plugin upgrade that asks for more is not granted it silently: the
 * installation stays on its old consent, and every call is refused until the
 * tenant installs again with the new list.
 */
export function effectiveGrant(
  definition: PluginDefinition,
  granted: readonly string[],
): { capabilities: PluginCapability[]; missing: PluginCapability[] } {
  const grantedSet = new Set(granted);
  return {
    capabilities: definition.capabilities.filter((c) => grantedSet.has(c)),
    missing: definition.capabilities.filter((c) => !grantedSet.has(c)),
  };
}
