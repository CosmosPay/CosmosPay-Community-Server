import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shapes for the four dashboard routes.
 *
 * These shipped as `@ApiOkResponse({ description })` with no `type`, so the
 * published spec recorded a description and no schema at all — nothing an
 * integrator or a generated client could use.
 */
export class SummaryTotalsEntity {
  @ApiProperty({ example: 137 }) all!: number;
  @ApiProperty({ example: 120 }) succeeded!: number;
  @ApiProperty({ example: 9 }) pending!: number;
  @ApiProperty({ example: 3 }) submitted!: number;
  @ApiProperty({ example: 4 }) failed!: number;
  @ApiProperty({ example: 1 }) cancelled!: number;
  @ApiProperty({ example: 0 }) expired!: number;

  @ApiProperty({
    description: 'Succeeded ÷ all, as a percentage rounded to one decimal.',
    example: 87.6,
  })
  successRate!: number;
}

export class AssetVolumeEntity {
  @ApiProperty({ example: 'XLM' }) asset!: string;

  @ApiProperty({
    description:
      'Exact decimal string. Summed as `numeric` in PostgreSQL and never ' +
      'round-tripped through a float, so seven-decimal Stellar amounts are exact.',
    example: '10420.5',
  })
  amount!: string;

  @ApiProperty({ example: 42 }) count!: number;
}

export class SeriesPointEntity {
  @ApiProperty({ example: '2026-06-21' }) date!: string;
  @ApiProperty({ example: 12 }) count!: number;
  @ApiProperty({ example: '842.75' }) volume!: string;
}

export class WebhookHealthEntity {
  @ApiProperty({ example: 3 }) endpoints!: number;
  @ApiProperty({ example: 1204 }) deliveries!: number;
  @ApiProperty({ example: 7 }) failedDeliveries!: number;
}

export class RecentPaymentEntity {
  @ApiProperty({ example: 'clz9xpi00001' }) id!: string;
  @ApiProperty({ example: 'PAY' }) kind!: string;
  @ApiProperty({ example: 'SUCCEEDED' }) status!: string;
  @ApiPropertyOptional({ nullable: true, example: '25.5' })
  amount!: string | null;
  @ApiProperty({ example: 'XLM' }) asset!: string;
  @ApiProperty({ example: 'GDEST…' }) destination!: string;
  @ApiProperty({ example: '2026-06-21T12:34:56.000Z' }) createdAt!: Date;
}

export class AnalyticsSummaryEntity {
  @ApiProperty({ type: SummaryTotalsEntity }) totals!: SummaryTotalsEntity;
  @ApiProperty({ type: [AssetVolumeEntity] }) volume!: AssetVolumeEntity[];
  @ApiProperty({ type: WebhookHealthEntity }) webhooks!: WebhookHealthEntity;

  @ApiProperty({ description: 'Distinct paying accounts.', example: 58 })
  customers!: number;

  @ApiProperty({
    type: [SeriesPointEntity],
    description: '30 daily buckets, pre-seeded so a quiet day is a zero.',
  })
  series!: SeriesPointEntity[];

  @ApiProperty({ type: [RecentPaymentEntity] })
  recent!: RecentPaymentEntity[];
}

export class AssetBalanceEntity {
  @ApiProperty({ example: 'XLM' }) asset!: string;
  @ApiProperty({ description: 'Settled.', example: '10420.5' }) amount!: string;
  @ApiProperty({ description: 'In flight.', example: '120' }) pending!: string;
  @ApiProperty({ example: 42 }) count!: number;
}

export class AnalyticsBalancesEntity {
  @ApiProperty({ type: [AssetBalanceEntity] }) data!: AssetBalanceEntity[];
  @ApiProperty({ example: 3 }) total!: number;
}

export class ApiLogEntity {
  @ApiProperty({ example: 'clz9xlog00001' }) id!: string;
  @ApiProperty({ example: 'POST' }) method!: string;
  @ApiProperty({ example: '/v1/swaps' }) path!: string;
  @ApiProperty({ example: 201 }) statusCode!: number;
  @ApiProperty({ example: 84 }) durationMs!: number;
  @ApiPropertyOptional({ nullable: true, example: '203.0.113.7' })
  ip!: string | null;
  @ApiPropertyOptional({ nullable: true, example: 'curl/8.4.0' })
  userAgent!: string | null;

  @ApiProperty({ enum: ['ok', 'pending', 'fail'], example: 'ok' })
  status!: string;

  @ApiProperty({ example: '2026-06-21T12:34:56.000Z' }) at!: Date;
}

export class ApiLogListEntity {
  @ApiProperty({ type: [ApiLogEntity] }) data!: ApiLogEntity[];

  @ApiProperty({
    description: 'Total matching rows — not the page length.',
    example: 41203,
  })
  total!: number;

  @ApiProperty({ example: 100 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}

export class WebhookLogEntity {
  @ApiProperty({ example: 'clz9xwd00001' }) id!: string;
  @ApiProperty({ example: 'we_9z8a1b0000abcd1234efgh' }) endpointId!: string;
  @ApiPropertyOptional({ nullable: true, example: 'https://acme.test/hooks' })
  url!: string | null;
  @ApiProperty({ example: 'PAYMENT_INTENT_SUCCEEDED' }) eventType!: string;
  @ApiProperty({ example: 'evt_2c3d4e5f-aaaa-bbbb-cccc-1234567890ab' })
  eventId!: string;
  @ApiProperty({ example: 1 }) attempts!: number;
  @ApiPropertyOptional({ nullable: true, example: 200 })
  responseStatus!: number | null;
  @ApiPropertyOptional({ nullable: true, example: null })
  error!: string | null;

  @ApiProperty({ enum: ['ok', 'pending', 'fail'], example: 'ok' })
  status!: string;

  @ApiProperty({ example: '2026-06-21T12:34:57.000Z' }) at!: Date;

  // `payload` is deliberately absent — see WebhookDeliveryEntity. This route is
  // gated on `webhooks:read` and a RECEIVER_UPDATED body is a KYC dossier.
}

export class WebhookLogListEntity {
  @ApiProperty({ type: [WebhookLogEntity] }) data!: WebhookLogEntity[];

  @ApiProperty({
    description: 'Total matching rows — not the page length.',
    example: 1204,
  })
  total!: number;

  @ApiProperty({ example: 100 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}
