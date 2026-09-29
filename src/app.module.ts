import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LoggingInterceptor } from '@/common/interceptors/logging.interceptor';
import configuration from '@/config/configuration';
import { validateEnv } from '@/config/env.validation';
import { ApisixGuard } from '@/common/guards/apisix.guard';
import { PermissionsGuard } from '@/common/guards/permissions.guard';
import { PublicKeyGuard } from '@/common/guards/public-key.guard';
import { RateLimitGuard } from '@/common/guards/rate-limit.guard';
import { ApisixContextMiddleware } from '@/common/middleware/apisix-context.middleware';
import { PrismaModule } from '@/prisma/prisma.module';
import { StellarModule } from '@/stellar/stellar.module';
import { HealthModule } from '@/health/health.module';
import { PaymentIntentsModule } from '@/payment-intents/payment-intents.module';
import { SwapsModule } from '@/swaps/swaps.module';
import { AssetsModule } from '@/assets/assets.module';
import { LiquidityPoolsModule } from '@/liquidity-pools/liquidity-pools.module';
import { ObserverModule } from '@/observer/observer.module';
import { WebhooksModule } from '@/webhooks/webhooks.module';
import { AnalyticsModule } from '@/analytics/analytics.module';
import { ActivityModule } from '@/activity/activity.module';
import { AdminModule } from '@/admin/admin.module';
import { ProductsModule } from '@/products/products.module';
import { CustomersModule } from '@/customers/customers.module';
import { AliasesModule } from '@/aliases/aliases.module';
import { WalletAuthModule } from '@/wallet-auth/wallet-auth.module';
import { RecoveryModule } from '@/recovery/recovery.module';
import { CommonModule } from '@/common/common.module';
import { PluginsModule } from '@/plugins/plugins.module';
import { NativePluginsModule } from '@/native-plugins/native-plugins.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate: validateEnv,
    }),
    // Wildcard so the webhook dispatcher can listen to `webhook.*` events.
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
    PrismaModule,
    StellarModule,
    HealthModule,
    PaymentIntentsModule,
    SwapsModule,
    LiquidityPoolsModule,
    // The asset registry: which (code, issuer) pairs we vouch for, per network.
    AssetsModule,
    // Background reconciler: flips swaps/LP ops to SUCCEEDED/FAILED/EXPIRED by
    // checking their txHash on Horizon, even when the customer self-broadcasts.
    ObserverModule,
    // Request-log retention prune (bounded deleteMany on a timer).
    CommonModule,
    WebhooksModule,
    AnalyticsModule,
    // Client-reported telemetry (wallet + dashboard): the half of what users do
    // that never becomes a request to this service.
    ActivityModule,
    AdminModule,
    ProductsModule,
    CustomersModule,
    AliasesModule,
    WalletAuthModule,
    // SEP-10 + SEP-30: this deployment as one of the two recovery servers, when
    // RECOVERY_ROLE says so. Inert (404) everywhere else.
    RecoveryModule,
    // Compiled-in extensions under /v1/plugins/{slug}: they reach the core only
    // through the capabilities a tenant grants, never Prisma. PLUGINS_ENABLED
    // picks which ones this deployment serves; none by default.
    PluginsModule,
    // First-party integrations that are not the chain itself — BlindPay's fiat
    // rails and KYC, DeFindex vaults — compiled in but imported only when
    // PLUGINS_ENABLED names them. The core never imports them directly.
    NativePluginsModule,
  ],
  providers: [
    // Persist a RequestLog row per request (powers the API logs view).
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    // Enforce the "only APISIX" check on every route by default.
    // Routes opt out with @Public().
    {
      provide: APP_GUARD,
      useClass: ApisixGuard,
    },
    // Then authorize against the API key's scopes (declared with
    // @RequirePermissions). Registered after ApisixGuard so the consumer is
    // already attached to the request.
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
    // Then confine the SHARED public key to the handlers that admit it
    // (@AllowPublicKey). It runs after the scope check because it only ever
    // narrows: holding the right scope is still necessary, and for one key held
    // by every anonymous caller it is no longer sufficient — a scope cannot tell
    // two holders of the same credential apart, and the read endpoints filter by
    // exactly that credential.
    {
      provide: APP_GUARD,
      useClass: PublicKeyGuard,
    },
    // Last, so a request that was never going to be served does not spend a
    // legitimate address's budget on its way to a 403. Opt-in per route with
    // @RateLimit; every other route passes straight through.
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Attach the gateway consumer context to every request before guards run.
    consumer.apply(ApisixContextMiddleware).forRoutes('*');
  }
}
