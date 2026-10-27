import { Module } from '@nestjs/common';
import { AnalyticsController } from '@/analytics/analytics.controller';
import { AnalyticsService } from '@/analytics/analytics.service';
import { UsdPricesService } from '@/analytics/usd-prices.service';
import { NearIntentsModule } from '@/near-intents/near-intents.module';

@Module({
  // NEAR Intents' token list prices the settled volume in USD.
  imports: [NearIntentsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, UsdPricesService],
})
export class AnalyticsModule {}
