import { Logger, Module, type Type } from '@nestjs/common';
import { ConditionalModule, ConfigService } from '@nestjs/config';
import { type AppConfig, nativePluginEnabled } from '@/config/configuration';
import { BlindpayPluginModule } from '@/native-plugins/blindpay/blindpay-plugin.module';
import { DefindexModule } from '@/native-plugins/defindex/defindex.module';
import {
  NATIVE_PLUGIN_SLUGS,
  type NativePluginSlug,
} from '@/plugins/plugins.constants';

/**
 * Every native plugin's root module, by slug. A `Record` over the slug union,
 * so adding a slug to `NATIVE_PLUGIN_SLUGS` does not compile until it has a
 * module here.
 */
const NATIVE_PLUGIN_MODULES: Record<NativePluginSlug, Type<unknown>> = {
  blindpay: BlindpayPluginModule,
  defindex: DefindexModule,
};

/**
 * The one place the core reaches a native plugin — and only to import it when
 * `PLUGINS_ENABLED` names it. Everything else in `src/` is forbidden from
 * importing `@/native-plugins/*` (see `eslint.config.mjs`); a plugin depends on
 * the core, never the other way round.
 */
@Module({
  imports: NATIVE_PLUGIN_SLUGS.map((slug) =>
    ConditionalModule.registerWhen(
      NATIVE_PLUGIN_MODULES[slug],
      nativePluginEnabled(slug),
      // Its "skipping registration" line prints the predicate's source; the
      // boot warning below says the same thing in words an operator can act on.
      { debug: false },
    ),
  ),
})
export class NativePluginsModule {
  constructor(config: ConfigService<AppConfig, true>) {
    // Before plugins, BlindPay and DeFindex were served whenever their keys
    // were set. A deployment upgraded without adding the slug keeps its keys
    // and silently loses the routes; say so at boot rather than in a 404.
    const enabled = config.get('plugins.native', { infer: true });
    const blindpay = config.get('blindpay', { infer: true });
    const configured: Record<NativePluginSlug, boolean> = {
      blindpay:
        blindpay.instances.prod.apiKey !== '' ||
        blindpay.instances.dev.apiKey !== '',
      defindex: config.get('defindex.apiKey', { infer: true }) !== '',
    };
    const logger = new Logger(NativePluginsModule.name);
    for (const slug of NATIVE_PLUGIN_SLUGS) {
      if (configured[slug] && !enabled.includes(slug)) {
        logger.warn(
          `${slug} is configured but not in PLUGINS_ENABLED, so its routes are ` +
            `not served. Add "${slug}" to PLUGINS_ENABLED to serve them.`,
        );
      }
    }
  }
}
