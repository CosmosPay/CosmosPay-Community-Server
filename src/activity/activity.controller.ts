import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { ACTIVITY_INGEST_RATE_LIMIT } from '@/activity/activity.constants';
import { ActivityService } from '@/activity/activity.service';
import { IngestActivityDto } from '@/activity/dto/ingest-activity.dto';
import {
  ActivitySummaryQueryDto,
  QueryActivityDto,
} from '@/activity/dto/query-activity.dto';
import {
  ActivityEventListEntity,
  ActivityIngestResultEntity,
  ActivitySummaryEntity,
} from '@/activity/entities/activity.entity';

/**
 * Client telemetry: what the wallet and the developer dashboard did, reported
 * by them.
 *
 * The read routes sit under `activity:read` and the write route under
 * `activity:write` rather than reusing `payments:*`: a key that only needs to
 * report crashes should not thereby be able to read a payment history, and the
 * wallet's auto-provisioned key holds both by design.
 *
 * URI versioning => /v1/activity/...
 */
@ApiTags('activity')
@Controller({ path: 'activity', version: '1' })
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Post('events')
  // Telemetry ingest. A wallet with no account still has crashes
  // worth knowing about, and refusing them here would silently blind us to
  // exactly the population that hits first-run failures. Events arriving on
  // this key are anonymous by construction — one shared consumer — so nothing
  // account-identifying may travel with them.
  @AllowPublicKey()
  @HttpCode(202)
  @RequirePermissions('activity:write')
  @RateLimit(ACTIVITY_INGEST_RATE_LIMIT)
  @ApiOperation({
    summary: 'Report a batch of client events (errors, metrics, transactions)',
    description:
      'Accepted, not created: the batch is written under the consumer the ' +
      'gateway authenticated, and nothing in the body can change that ' +
      'attribution. Over-long messages are truncated and an over-sized `props` ' +
      'is replaced with a marker rather than failing the call — losing a whole ' +
      'batch to one malformed field is worst exactly when the client is in a ' +
      'state it did not anticipate.',
  })
  @ApiAcceptedResponse({ type: ActivityIngestResultEntity })
  ingest(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: IngestActivityDto,
    @Req() request: Request,
  ) {
    return this.activity.ingest(consumer, dto, request);
  }

  @Get('events')
  @RequirePermissions('activity:read')
  @ApiOperation({
    summary: 'Recent client events for this consumer, newest first',
    description:
      '`level` is a floor, not an exact match: `level=warn` returns warnings ' +
      'and errors.',
  })
  @ApiOkResponse({ type: ActivityEventListEntity })
  list(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryActivityDto,
  ) {
    return this.activity.list(consumer, query);
  }

  @Get('summary')
  @RequirePermissions('activity:read')
  @ApiOperation({
    summary: 'Counts, top event types, top errors and a daily series',
  })
  @ApiOkResponse({ type: ActivitySummaryEntity })
  summary(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: ActivitySummaryQueryDto,
  ) {
    return this.activity.summary(consumer, query);
  }
}
