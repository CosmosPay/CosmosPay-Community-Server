import { resolve } from 'node:path';
import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@/config/configuration';
import { CustomersModule } from '@/customers/customers.module';
import { PaymentIntentsModule } from '@/payment-intents/payment-intents.module';
import { PluginCoreAccessService } from '@/plugins/plugin-core-access.service';
import { PluginEventBridge } from '@/plugins/plugin-event-bridge.service';
import { loadPlugins } from '@/plugins/plugin-folder';
import { PluginHttpClient } from '@/plugins/plugin-http.client';
import { PluginInstallationsService } from '@/plugins/plugin-installations.service';
import {
  PLUGIN_CATALOG_TOKEN,
  PluginRegistryService,
} from '@/plugins/plugin-registry.service';
import { PluginRuntimeService } from '@/plugins/plugin-runtime.service';
import { parseTrustedKeys, supportKeys } from '@/plugins/plugin-signature';
import { PluginStorageService } from '@/plugins/plugin-storage.service';
import { PLUGINS_FOLDER } from '@/plugins/plugins.constants';
import { PluginsController } from '@/plugins/plugins.controller';
import type { PluginDefinition } from '@/plugins/sdk';
import { ProductsModule } from '@/products/products.module';

@Module({
  // The core modules a plugin can reach, through their own services only —
  // `PluginCoreAccessService` is the one place that calls them.
  imports: [CustomersModule, ProductsModule, PaymentIntentsModule],
  controllers: [PluginsController],
  providers: [
    {
      // The enabled plugins, read from the one plugins folder (`plugins/` at
      // the repository root) and verified against support's keys plus the
      // operator's. The registry validates the lot and refuses to boot on
      // anything wrong.
      provide: PLUGIN_CATALOG_TOKEN,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<AppConfig, true>,
      ): readonly PluginDefinition[] => {
        const plugins = config.get('plugins', { infer: true });
        const logger = new Logger('PluginLoader');
        return loadPlugins({
          // Relative to the working directory, like the other paths the
          // service reads: the repo root, under `npm start` and `start:prod`.
          root: resolve(process.cwd(), PLUGINS_FOLDER),
          slugs: plugins.enabled,
          trustedKeys: [
            ...supportKeys(),
            ...parseTrustedKeys(plugins.trustedKeys),
          ],
          allowUnsigned: plugins.allowUnsigned,
          nodeEnv: config.get('nodeEnv', { infer: true }),
          warn: (message) => logger.warn(message),
        });
      },
    },
    PluginRegistryService,
    PluginInstallationsService,
    PluginStorageService,
    PluginCoreAccessService,
    PluginHttpClient,
    PluginRuntimeService,
    PluginEventBridge,
  ],
})
export class PluginsModule {}
