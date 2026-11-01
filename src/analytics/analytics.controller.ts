import { Controller, Get, Query } from '@nestjs/common';
import { WidePaginationQueryDto } from '@/common/dto/pagination.query.dto';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import {
  AnalyticsBalancesEntity,
  AnalyticsSeriesEntity,
  AnalyticsSummaryEntity,
  ApiLogListEntity,
  WebhookLogListEntity,
} from '@/analytics/entities/analytics.entity';
import { AnalyticsService } from '@/analytics/analytics.service';
import { SummarySeriesQueryDto } from '@/analytics/dto/summary-series.query.dto';

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
    description:
      "The settled volume per asset, and every asset valued in USD at NEAR Intents' current reference price (`volumeUsd`, indicative). Without those prices the USD fields are null and the rest answers as usual.",
  })
  @ApiOkResponse({ type: AnalyticsSummaryEntity })
  summary(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.analytics.summary(consumer);
  }

  @Get('summary/series')
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary: 'Activity per day, week, month or year, with the window before',
    description:
      'Payments, swaps, liquidity operations, webhook deliveries and private payments, each grouped into the buckets of `period` (UTC, weeks from Monday, a quiet bucket a zero), with the totals of the window and of the window before, for growth. ' +
      "Payments carry their settled volume in USD too (`volumeUsd`), each asset valued at NEAR Intents' current reference price (indicative). Without those prices the USD fields are null and the rest answers as usual.",
  })
  @ApiOkResponse({ type: AnalyticsSeriesEntity })
  series(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: SummarySeriesQueryDto,
  ) {
    return this.analytics.series(consumer, query.period ?? 'day');
  }

  @Get('balances')
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary: 'Settled (and pending) amount per asset',
    description:
      "Per chain and asset, what this consumer's payment intents settled " +
      '(`amount`, with their `count`) and what is still `PENDING` or ' +
      '`SUBMITTED` (`pending`), on the API key’s network only (mainnet for a ' +
      'production key, testnet for a test key). Largest settled amount first, ' +
      'as `{ data, total }` with no paging. Reused per consumer and network for ' +
      'a few seconds (10 by default), so a new payment can take that long to ' +
      'show.',
  })
  @ApiOkResponse({ type: AnalyticsBalancesEntity })
  balances(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.analytics.balances(consumer);
  }

  @Get('logs')
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary: 'Recent API requests reaching the service (with details)',
    description:
      "This consumer's requests, newest first, with method, path, status " +
      'code, duration, client IP and user agent; the dashboard’s own console ' +
      'calls are left out. `status` is `ok` below 400, `pending` for a 4xx and ' +
      '`fail` for a 5xx. ' +
      'Paged with `take` (default and maximum 100) and `skip`; answers ' +
      '`{ data, total, take, skip }`, never cached.',
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
    description:
      'Deliveries to every webhook endpoint of this consumer, newest first: ' +
      'the endpoint and its `url`, `eventType`, `eventId`, `attempts`, the ' +
      'last `responseStatus` and `error`, and `status` (`ok` when delivered, ' +
      '`fail` when failed, `pending` otherwise). The payload is never ' +
      'included. Paged with ' +
      '`take` (default and maximum 100) and `skip`; answers ' +
      '`{ data, total, take, skip }`, never cached.',
  })
  @ApiOkResponse({ type: WebhookLogListEntity })
  webhookLogs(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: WidePaginationQueryDto,
  ) {
    return this.analytics.webhookLogs(consumer, query);
  }
}
