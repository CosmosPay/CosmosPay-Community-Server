import { CHAINS } from '@/chains/chains.constants';
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
  @ApiProperty({ enum: CHAINS, example: 'stellar' }) chain!: string;
  @ApiProperty({
    description:
      'The chain’s coin (XLM, SOL, MON) for `native`, else the code.',
    example: 'XLM',
  })
  asset!: string;

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
  @ApiProperty({ enum: CHAINS, example: 'stellar' }) chain!: string;
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

export class SeriesBucketEntity {
  @ApiProperty({
    description: 'The first day of the bucket (UTC; weeks start on Monday).',
    example: '2026-10-01',
  })
  start!: string;
  @ApiProperty({
    description: 'Payments created in the bucket, any status.',
    example: 31,
  })
  count!: number;
  @ApiProperty({ example: 27 }) succeeded!: number;
  @ApiProperty({ description: 'Failed, cancelled or expired.', example: 3 })
  failed!: number;
  @ApiProperty({
    description: 'Settled volume, every asset added.',
    example: '1842.5',
  })
  volume!: string;
}

export class SeriesWindowEntity {
  @ApiProperty({ example: 284 }) count!: number;
  @ApiProperty({ example: 251 }) succeeded!: number;
  @ApiProperty({ example: 19 }) failed!: number;
  @ApiProperty({ example: '17410.25' }) volume!: string;
}

export class SeriesTotalsEntity extends SeriesWindowEntity {
  @ApiProperty({
    description: 'Distinct paying accounts in the window.',
    example: 96,
  })
  payers!: number;
}

export class SeriesOutcomeCountsEntity {
  @ApiProperty({
    description: 'Created in the bucket or window, any status.',
    example: 42,
  })
  count!: number;
  @ApiProperty({ example: 37 }) succeeded!: number;
  @ApiProperty({
    description:
      'Given up on: failed or expired (and, for a cross-chain swap, refunded).',
    example: 3,
  })
  failed!: number;
}

export class SeriesSwapBucketEntity extends SeriesOutcomeCountsEntity {
  @ApiProperty({
    description:
      'The first day of the bucket (UTC; weeks start on Monday), the same as the payments bucket at that index.',
    example: '2026-10-01',
  })
  start!: string;
}

export class SeriesSwapsByKindEntity {
  @ApiProperty({ description: 'Stellar DEX swaps.', example: 30 })
  dex!: number;
  @ApiProperty({
    description: 'Solana (Jupiter) and Monad (Kuru Flow) swaps. Mainnet only.',
    example: 8,
  })
  chain!: number;
  @ApiProperty({
    description: 'Swaps between networks through NEAR Intents. Mainnet only.',
    example: 4,
  })
  crossChain!: number;
  @ApiProperty({
    description:
      'USDT0 sent from Stellar to an EVM network through LayerZero (`/v1/usdt0`). Mainnet only.',
    example: 2,
  })
  usdt0!: number;
}

export class SeriesSwapTotalsEntity extends SeriesOutcomeCountsEntity {
  @ApiProperty({
    description:
      'Not final yet: unsigned, submitted (a USDT0 transfer LayerZero is still delivering included), or a cross-chain swap awaiting or processing its deposit.',
    example: 2,
  })
  inProgress!: number;
  @ApiProperty({
    type: SeriesSwapsByKindEntity,
    description: 'The window’s swaps per kind, any status.',
  })
  byKind!: SeriesSwapsByKindEntity;
}

export class SeriesSwapsEntity {
  @ApiProperty({
    type: [SeriesSwapBucketEntity],
    description:
      'Swaps of every kind per bucket, on the same buckets as the payments, pre-seeded so a quiet bucket is a zero.',
  })
  buckets!: SeriesSwapBucketEntity[];
  @ApiProperty({
    type: SeriesSwapTotalsEntity,
    description: 'The window the buckets cover.',
  })
  totals!: SeriesSwapTotalsEntity;
  @ApiProperty({
    type: SeriesOutcomeCountsEntity,
    description: 'The window of the same length just before it, for growth.',
  })
  previous!: SeriesOutcomeCountsEntity;
}

export class SeriesLiquidityBucketEntity extends SeriesOutcomeCountsEntity {
  @ApiProperty({
    description:
      'The first day of the bucket (UTC; weeks start on Monday), the same as the payments bucket at that index.',
    example: '2026-10-01',
  })
  start!: string;
}

export class SeriesLiquidityEntity {
  @ApiProperty({
    type: [SeriesLiquidityBucketEntity],
    description:
      'Liquidity pool deposits and withdrawals per bucket, on the same buckets as the payments, pre-seeded so a quiet bucket is a zero.',
  })
  buckets!: SeriesLiquidityBucketEntity[];
  @ApiProperty({
    type: SeriesOutcomeCountsEntity,
    description: 'Liquidity pool deposits and withdrawals in the window.',
  })
  totals!: SeriesOutcomeCountsEntity;
  @ApiProperty({
    type: SeriesOutcomeCountsEntity,
    description: 'The window of the same length just before it, for growth.',
  })
  previous!: SeriesOutcomeCountsEntity;
}

export class SeriesWebhookCountsEntity {
  @ApiProperty({
    description: 'Deliveries created in the window, any status.',
    example: 310,
  })
  deliveries!: number;
  @ApiProperty({
    description:
      'Of those, the ones whose last attempt failed, as GET /v1/summary counts them (the sweeper may still redeliver one).',
    example: 4,
  })
  failed!: number;
}

export class SeriesWebhookBucketEntity {
  @ApiProperty({
    description:
      'The first day of the bucket (UTC; weeks start on Monday), the same as the payments bucket at that index.',
    example: '2026-10-01',
  })
  start!: string;
  @ApiProperty({
    description: 'Deliveries created in the bucket, any status.',
    example: 26,
  })
  deliveries!: number;
  @ApiProperty({
    description:
      'Of those, the ones whose last attempt failed, as GET /v1/summary counts them.',
    example: 1,
  })
  failed!: number;
}

export class SeriesWebhooksEntity {
  @ApiProperty({
    type: [SeriesWebhookBucketEntity],
    description:
      'Deliveries per bucket, on the same buckets as the payments, pre-seeded so a quiet bucket is a zero.',
  })
  buckets!: SeriesWebhookBucketEntity[];
  @ApiProperty({
    type: SeriesWebhookCountsEntity,
    description:
      'Deliveries to every endpoint of the consumer in the window. Not scoped by network: an endpoint belongs to none.',
  })
  totals!: SeriesWebhookCountsEntity;
  @ApiProperty({
    type: SeriesWebhookCountsEntity,
    description: 'The window of the same length just before it, for growth.',
  })
  previous!: SeriesWebhookCountsEntity;
}

export class AnalyticsSeriesEntity {
  @ApiProperty({ enum: ['day', 'week', 'month', 'year'], example: 'month' })
  period!: string;
  @ApiProperty({
    type: [SeriesBucketEntity],
    description:
      '30 days, 12 weeks, 12 months or 5 years, oldest first, pre-seeded so a quiet bucket is a zero.',
  })
  buckets!: SeriesBucketEntity[];
  @ApiProperty({
    type: SeriesTotalsEntity,
    description: 'The window the buckets cover.',
  })
  totals!: SeriesTotalsEntity;
  @ApiProperty({
    type: SeriesWindowEntity,
    description: 'The window of the same length just before it, for growth.',
  })
  previous!: SeriesWindowEntity;
  @ApiProperty({
    type: SeriesSwapsEntity,
    description:
      'Swaps of every kind (Stellar DEX, Solana and Monad, cross-chain, USDT0 sent through LayerZero) on the network the key targets: a sandbox key counts no Solana, Monad, cross-chain swap or USDT0 transfer, which run on mainnet only.',
  })
  swaps!: SeriesSwapsEntity;
  @ApiProperty({
    type: SeriesLiquidityEntity,
    description: 'Liquidity pool operations on the network the key targets.',
  })
  liquidity!: SeriesLiquidityEntity;
  @ApiProperty({
    type: SeriesWebhooksEntity,
    description: 'Webhook deliveries to the consumer’s endpoints.',
  })
  webhooks!: SeriesWebhooksEntity;
}

export class AssetBalanceEntity {
  @ApiProperty({ enum: CHAINS, example: 'stellar' }) chain!: string;
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
    description: 'Total matching rows, not the page length.',
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
    description: 'Total matching rows, not the page length.',
    example: 1204,
  })
  total!: number;

  @ApiProperty({ example: 100 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}
