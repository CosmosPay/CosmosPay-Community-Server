import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@/config/configuration';
import {
  hasSecretConfig,
  validatePluginDefinition,
} from '@/plugins/plugin-manifest';
import { PLUGINS_SECRET_MIN_LENGTH } from '@/plugins/plugins.constants';
import type { PluginDefinition } from '@/plugins/sdk';

/**
 * Injection token for the loaded plugins. Production binds it to what
 * `loadPlugins` read from `plugins/`; a spec binds its own fakes.
 */
export const PLUGIN_CATALOG_TOKEN = Symbol('PLUGIN_CATALOG');

/**
 * The plugins this deployment serves: the ones loaded from `plugins/`,
 * validated, filtered down to `PLUGINS_ENABLED`.
 *
 * Every check runs in the constructor, so a bad manifest, an unknown slug in
 * `PLUGINS_ENABLED` or a secret field with no `PLUGINS_SECRET` stops the boot
 * instead of surfacing as a 500 on the first request that touches the plugin.
 * Plugins that are not enabled are never read here; CI validates every folder
 * in `plugins/` instead (`plugins-folder.spec.ts`).
 */
@Injectable()
export class PluginRegistryService {
  private readonly logger = new Logger(PluginRegistryService.name);
  private readonly enabled: ReadonlyMap<string, PluginDefinition>;

  constructor(
    @Inject(PLUGIN_CATALOG_TOKEN) catalog: readonly PluginDefinition[],
    config: ConfigService<AppConfig, true>,
  ) {
    const { enabled: enabledSlugs, secret } = config.get('plugins', {
      infer: true,
    });

    const errors = catalog.flatMap(validatePluginDefinition);
    const seen = new Set<string>();
    for (const plugin of catalog) {
      if (seen.has(plugin.slug)) {
        errors.push(`plugin "${plugin.slug}" is in the catalog twice`);
      }
      seen.add(plugin.slug);
    }

    const bySlug = new Map(catalog.map((p) => [p.slug, p] as const));
    const enabled = new Map<string, PluginDefinition>();
    for (const slug of enabledSlugs) {
      const plugin = bySlug.get(slug);
      if (!plugin) {
        errors.push(
          `PLUGINS_ENABLED lists "${slug}", which was not loaded from plugins/`,
        );
        continue;
      }
      if (
        hasSecretConfig(plugin) &&
        secret.length < PLUGINS_SECRET_MIN_LENGTH
      ) {
        errors.push(
          `plugin "${slug}" has secret settings, so PLUGINS_SECRET must be set ` +
            `(at least ${PLUGINS_SECRET_MIN_LENGTH} characters) to seal them`,
        );
      }
      enabled.set(slug, Object.freeze(plugin));
    }

    if (errors.length > 0) {
      throw new Error(
        `Invalid plugin configuration:\n  - ${errors.join('\n  - ')}`,
      );
    }

    this.enabled = enabled;
    if (enabled.size > 0) {
      this.logger.log(
        `Plugins enabled: ${[...enabled.values()]
          .map((p) => `${p.slug}@${p.version}`)
          .join(', ')}`,
      );
    }
  }

  /** The plugin, if this deployment serves it. */
  get(slug: string): PluginDefinition | undefined {
    return this.enabled.get(slug);
  }

  list(): PluginDefinition[] {
    return [...this.enabled.values()];
  }
}
