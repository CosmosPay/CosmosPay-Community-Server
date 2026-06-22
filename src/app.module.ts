import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { ApisixGuard } from './common/guards/apisix.guard';
import { ApisixContextMiddleware } from './common/middleware/apisix-context.middleware';
import { PrismaModule } from './prisma/prisma.module';
import { StellarModule } from './stellar/stellar.module';
import { HealthModule } from './health/health.module';
import { PaymentIntentsModule } from './payment-intents/payment-intents.module';
import { WebhooksModule } from './webhooks/webhooks.module';

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
    WebhooksModule,
  ],
  providers: [
    // Enforce the "only APISIX" check on every route by default.
    // Routes opt out with @Public().
    {
      provide: APP_GUARD,
      useClass: ApisixGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Attach the gateway consumer context to every request before guards run.
    consumer.apply(ApisixContextMiddleware).forRoutes('*');
  }
}
