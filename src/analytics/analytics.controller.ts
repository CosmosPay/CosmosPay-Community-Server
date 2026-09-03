import { Controller, Get, Query } from '@nestjs/common';
import { WidePaginationQueryDto } from '@/common/dto/pagination.query.dto';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import {
  AnalyticsBalancesEntity,
  AnalyticsSummaryEntity,
  ApiLogListEntity,
  WebhookLogListEntity,
} from '@/analytics/entities/analytics.entity';
import { AnalyticsService } from '@/analytics/analytics.service';

// Read-only dashboard aggregates. URI versioning => /v1/...
@ApiTags('analytics')
@Controller({ version: '1' })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('summary')
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary:
      'Overview metrics: totals, settled volume, webhook health, 30-day series',
  })
  @ApiOkResponse({ type: AnalyticsSummaryEntity })
  summary(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.analytics.summary(consumer);
  }

  @Get('balances')
  @RequirePermissions('payments:read')
  @ApiOperation({ summary: 'Settled (and pending) amount per asset' })
  @ApiOkResponse({ type: AnalyticsBalancesEntity })
  balances(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.analytics.balances(consumer);
  }

  @Get('logs')
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary: 'Recent API requests reaching the service (with details)',
  })
  @ApiOkResponse({ type: ApiLogListEntity })
  apiLogs(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: WidePaginationQueryDto,
  ) {
    return this.analytics.apiLogs(consumer, query);
  }

  @Get('logs/webhooks')
  @RequirePermissions('webhooks:read')
  @ApiOperation({
    summary: 'Recent webhook deliveries across all endpoints (with details)',
  })
  @ApiOkResponse({ type: WebhookLogListEntity })
  webhookLogs(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: WidePaginationQueryDto,
  ) {
    return this.analytics.webhookLogs(consumer, query);
  }
}
