import { CHAINS } from '@/chains/chains.constants';
import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

/**
 * Response shapes for the four dashboard routes.
 *
 * These shipped as `@ApiOkResponse({ description })` with no `type`, so the
 * published spec recorded a description and no schema at all — nothing an
 * integrator or a generated client could use.
 */
@ApiSchema({
  description:
    "Counts of the consumer's payment intents per status on the API key's network, with no date bound.",
})
export class SummaryTotalsEntity {
  @ApiProperty({
    description: 'Every payment intent, any status.',
    example: 137,
  })
  all!: number;
  @ApiProperty({
    description:
      'Payment intents in status `SUCCEEDED` (confirmed on their chain).',
    example: 120,
  })
  succeeded!: number;
  @ApiProperty({
    description:
      'Payment intents in status `PENDING` (created, awaiting payment).',
    example: 9,
  })
  pending!: number;
  @ApiProperty({
    description:
      'Payment intents in status `SUBMITTED`: a signed transaction hash was reported, not yet confirmed.',
    example: 3,
  })
  submitted!: number;
  @ApiProperty({
    description:
      'Payment intents in status `FAILED` (rejected on the network).',
    example: 4,
  })
  failed!: number;
  @ApiProperty({
    description: 'Payment intents in status `CANCELLED`.',
    example: 1,
  })
  cancelled!: number;
  @ApiProperty({
    description:
      'Payment intents in status `EXPIRED` (unpaid past their expiry).',
    example: 0,
  })
  expired!: number;

  @ApiProperty({
    description: 'Succeeded ÷ all, as a percentage rounded to one decimal.',
    example: 87.6,
  })
  successRate!: number;
}

@ApiSchema({
  description:
    'Settled payment volume for one chain and asset, over every settled payment intent.',
})
export class AssetVolumeEntity {
  @ApiProperty({
    enum: CHAINS,
    description: 'Chain the payments settled on.',
    example: 'stellar',
  })
  chain!: string;
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

  @ApiProperty({
    description: 'Settled payment intents in this chain and asset.',
    example: 42,
  })
  count!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "`amount` in USD with two decimals, valued at NEAR Intents’ current reference price for each asset (its token list, cached for a few minutes): an indicative figure at today's price, not the price on the day each payment settled. A mainnet token is priced by its contract (on " +
      'Stellar its code and issuer), so a token NEAR Intents does not list has no price; a ' +
      'test-network token takes the price of its mainnet namesake. When the code comes from ' +
      'several issuers, only the priced ones are added. Null when none is priced, or when the ' +
      'prices could not be read.',
    example: '10418.42',
  })
  amountUsd!: string | null;
}

@ApiSchema({
  description: "One UTC day of the summary's 30-day payment series.",
})
export class SeriesPointEntity {
  @ApiProperty({
    description: 'The UTC day, `YYYY-MM-DD`.',
    example: '2026-06-21',
  })
  date!: string;
  @ApiProperty({
    description: 'Payment intents created that day, any status.',
    example: 12,
  })
  count!: number;
  @ApiProperty({
    description:
      "Settled amount of that day's payment intents, every asset added, as a decimal string.",
    example: '842.75',
  })
  volume!: string;
}

@ApiSchema({
  description:
    "The consumer's webhook endpoints and their deliveries. Not scoped by network: an endpoint belongs to none.",
})
export class WebhookHealthEntity {
  @ApiProperty({
    description: 'Webhook endpoints the consumer has registered.',
    example: 3,
  })
  endpoints!: number;
  @ApiProperty({
    description: 'Deliveries to those endpoints, any status.',
    example: 1204,
  })
  deliveries!: number;
  @ApiProperty({
    description: 'Of those, the deliveries in status `FAILED`.',
    example: 7,
  })
  failedDeliveries!: number;
}

@ApiSchema({
  description:
    'A settled payment intent, as the summary lists the latest ones.',
})
export class RecentPaymentEntity {
  @ApiProperty({ description: 'Payment intent id.', example: 'clz9xpi00001' })
  id!: string;
  @ApiProperty({
    description:
      'How the intent was built: `TX` (an unsigned transaction for a known payer) or `PAY` (no payer known up front).',
    example: 'PAY',
  })
  kind!: string;
  @ApiProperty({
    description: 'Payment intent status, always `SUCCEEDED` here.',
    example: 'SUCCEEDED',
  })
  status!: string;
  @ApiProperty({
    enum: CHAINS,
    description: 'Chain the payment settled on.',
    example: 'stellar',
  })
  chain!: string;
  @ApiPropertyOptional({
    nullable: true,
    description:
      "Amount as a decimal string in the asset's units. Null when the intent was created without one (a `PAY` intent may omit it).",
    example: '25.5',
  })
  amount!: string | null;
  @ApiProperty({
    description:
      "Asset code, or the chain's coin (XLM, SOL, MON) for the native asset.",
    example: 'XLM',
  })
  asset!: string;
  @ApiProperty({
    description: "Payee account, in the chain's own address format.",
    example: 'GDEST…',
  })
  destination!: string;
  @ApiProperty({
    description: 'When the intent was created (ISO 8601 date-time).',
    example: '2026-06-21T12:34:56.000Z',
  })
  createdAt!: Date;
}

@ApiSchema({
  description:
    "Overview of the consumer's payment intents on the API key's network: counts per status, settled volume per asset and in USD, webhook health, distinct payers, a 30-day daily series and the latest settled payments.",
})
export class AnalyticsSummaryEntity {
  @ApiProperty({
    type: SummaryTotalsEntity,
    description: 'Payment intent counts per status.',
  })
  totals!: SummaryTotalsEntity;
  @ApiProperty({
    type: [AssetVolumeEntity],
    description: 'Settled volume per chain and asset.',
  })
  volume!: AssetVolumeEntity[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Every settled payment in USD with two decimals, valued at NEAR Intents’ current reference price for each asset (its token list, cached for a few minutes): an indicative figure at today's price, not the price on the day each payment settled. Payments in an asset with no " +
      'price are left out and counted in `unpriced`. Null only when there were settled ' +
      "payments and NEAR Intents' prices could not be read; `0.00` when nothing settled.",
    example: '12843.17',
  })
  volumeUsd!: string | null;

  @ApiProperty({
    description:
      "Settled payments `volumeUsd` leaves out: their asset has no USD price (all of them when NEAR Intents' prices could not be read).",
    example: 0,
  })
  unpriced!: number;
  @ApiProperty({
    type: WebhookHealthEntity,
    description: 'Webhook endpoints and deliveries of the consumer.',
  })
  webhooks!: WebhookHealthEntity;

  @ApiProperty({ description: 'Distinct paying accounts.', example: 58 })
  customers!: number;

  @ApiProperty({
    type: [SeriesPointEntity],
    description: '30 daily buckets, pre-seeded so a quiet day is a zero.',
  })
  series!: SeriesPointEntity[];

  @ApiProperty({
    type: [RecentPaymentEntity],
    description:
      'The 6 most recently created settled payment intents, newest first.',
  })
  recent!: RecentPaymentEntity[];
}

@ApiSchema({
  description: 'Payment intents created in one bucket of the series.',
})
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
  @ApiProperty({
    description: 'Of those, the ones settled (status `SUCCEEDED`).',
    example: 27,
  })
  succeeded!: number;
  @ApiProperty({ description: 'Failed, cancelled or expired.', example: 3 })
  failed!: number;
  @ApiProperty({
    description: 'Settled volume, every asset added.',
    example: '1842.5',
  })
  volume!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The bucket's settled payments in USD with two decimals, valued at NEAR Intents’ current reference price for each asset (its token list, cached for a few minutes): an indicative figure at today's price, not the price on the day each payment settled. Payments in an asset " +
      "with no price add nothing (the window's `unpriced` counts them). Null only when the " +
      "bucket has settled payments and NEAR Intents' prices could not be read.",
    example: '1790.36',
  })
  volumeUsd!: string | null;
}

@ApiSchema({
  description: 'Payment intent totals for a whole window of the series.',
})
export class SeriesWindowEntity {
  @ApiProperty({
    description: 'Payment intents created in the window, any status.',
    example: 284,
  })
  count!: number;
  @ApiProperty({
    description: 'Of those, the ones settled (status `SUCCEEDED`).',
    example: 251,
  })
  succeeded!: number;
  @ApiProperty({
    description: 'Of those, the ones failed, cancelled or expired.',
    example: 19,
  })
  failed!: number;
  @ApiProperty({
    description:
      'Settled amount of those payment intents, every asset added, as a decimal string.',
    example: '17410.25',
  })
  volume!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The window's settled payments in USD with two decimals, valued at NEAR Intents’ current reference price for each asset (its token list, cached for a few minutes): an indicative figure at today's price, not the price on the day each payment settled. Null only when the " +
      "window has settled payments and NEAR Intents' prices could not be read.",
    example: '16982.04',
  })
  volumeUsd!: string | null;
  @ApiProperty({
    description:
      "Settled payments of the window `volumeUsd` leaves out: their asset has no USD price (all of them when NEAR Intents' prices could not be read).",
    example: 0,
  })
  unpriced!: number;
}

@ApiSchema({
  description:
    'Payment intent totals for the window the buckets cover, with its distinct payers.',
})
export class SeriesTotalsEntity extends SeriesWindowEntity {
  @ApiProperty({
    description: 'Distinct paying accounts in the window.',
    example: 96,
  })
  payers!: number;
}

@ApiSchema({
  description:
    'Swaps or liquidity operations by outcome, for a bucket or a window of the series.',
})
export class SeriesOutcomeCountsEntity {
  @ApiProperty({
    description: 'Created in the bucket or window, any status.',
    example: 42,
  })
  count!: number;
  @ApiProperty({
    description:
      'Of those, the ones that succeeded (for a USDT0 transfer, delivered).',
    example: 37,
  })
  succeeded!: number;
  @ApiProperty({
    description:
      'Given up on: failed or expired (and, for a cross-chain swap, refunded).',
    example: 3,
  })
  failed!: number;
}

@ApiSchema({
  description:
    'Swaps of every kind created in one bucket of the series, with the USD value of the completed ones.',
})
export class SeriesSwapBucketEntity extends SeriesOutcomeCountsEntity {
  @ApiProperty({
    description:
      'The first day of the bucket (UTC; weeks start on Monday), the same as the payments bucket at that index.',
    example: '2026-10-01',
  })
  start!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The bucket’s settled swap volume in USD, two decimals: what the completed swaps sold, each asset at NEAR Intents' current price. Null when no price could be read; an asset with no price counts as zero.",
    example: '1250.40',
  })
  volumeUsd!: string | null;
}

@ApiSchema({
  description: "A window's swaps split by kind, any status.",
})
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

@ApiSchema({
  description:
    'Swap totals for the window the buckets cover: outcomes, split by kind and USD volume.',
})
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
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The window’s settled swap volume in USD, two decimals: what the completed swaps sold, each asset at NEAR Intents' current price. Null when no price could be read; an asset with no price counts as zero.",
    example: '1250.40',
  })
  volumeUsd!: string | null;
  @ApiProperty({
    description:
      'Completed swaps whose sold asset has no USD price (a network or token NEAR Intents does not list), left out of volumeUsd.',
    example: 0,
  })
  unpriced!: number;
}

@ApiSchema({
  description:
    'Swap totals for the window of the same length just before the current one, for growth.',
})
export class SeriesSwapPreviousEntity extends SeriesOutcomeCountsEntity {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The window before’s settled swap volume in USD, two decimals: what the completed swaps sold, each asset at NEAR Intents' current price. Null when no price could be read; an asset with no price counts as zero.",
    example: '1250.40',
  })
  volumeUsd!: string | null;
}

@ApiSchema({
  description:
    'Swaps of every kind (Stellar DEX, Solana and Monad, cross-chain, USDT0 transfers) per bucket, with the totals of the window and of the window before.',
})
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
    type: SeriesSwapPreviousEntity,
    description: 'The window of the same length just before it, for growth.',
  })
  previous!: SeriesSwapPreviousEntity;
}

@ApiSchema({
  description:
    'Liquidity pool deposits and withdrawals created in one bucket of the series.',
})
export class SeriesLiquidityBucketEntity extends SeriesOutcomeCountsEntity {
  @ApiProperty({
    description:
      'The first day of the bucket (UTC; weeks start on Monday), the same as the payments bucket at that index.',
    example: '2026-10-01',
  })
  start!: string;
}

@ApiSchema({
  description:
    'Liquidity pool deposits and withdrawals per bucket, with the totals of the window and of the window before.',
})
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

@ApiSchema({
  description: 'Webhook deliveries created in a window of the series.',
})
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

@ApiSchema({
  description: 'Webhook deliveries created in one bucket of the series.',
})
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

@ApiSchema({
  description:
    "Webhook deliveries to the consumer's endpoints per bucket, with the totals of the window and of the window before.",
})
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

@ApiSchema({
  description:
    'Private payments created in one bucket of the series, amounts in XLM.',
})
export class SeriesPrivatePaymentBucketEntity {
  @ApiProperty({
    description:
      'The first day of the bucket (UTC; weeks start on Monday), the same as the payments bucket at that index.',
    example: '2026-10-01',
  })
  start!: string;
  @ApiProperty({
    description: 'Private payments created in the bucket, any status.',
    example: 12,
  })
  count!: number;
  @ApiProperty({
    description: 'Settled: both transfers confirmed.',
    example: 9,
  })
  succeeded!: number;
  @ApiProperty({
    description:
      'Past their deadline without settling (a pending payment reads as expired once its deadline passes).',
    example: 2,
  })
  expired!: number;
  @ApiProperty({
    description:
      'Settled amount in XLM, what the payers paid (the commission included).',
    example: '450.5',
  })
  volume!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The bucket's settled amount in USD with two decimals, valued at XLM's current reference price on NEAR Intents (an indicative figure at today's price). " +
      "Null only when there is something settled and NEAR Intents' prices could not be read.",
    example: '112.63',
  })
  volumeUsd!: string | null;
}

@ApiSchema({
  description:
    'Private payment totals for a window of the series, amounts in XLM.',
})
export class SeriesPrivatePaymentWindowEntity {
  @ApiProperty({
    description: 'Private payments created in the window, any status.',
    example: 48,
  })
  count!: number;
  @ApiProperty({
    description: 'Of those, the ones settled (status `SUCCEEDED`).',
    example: 41,
  })
  succeeded!: number;
  @ApiProperty({
    description:
      'Past their deadline without settling (a pending payment reads as expired once its deadline passes).',
    example: 5,
  })
  expired!: number;
  @ApiProperty({
    description:
      'Settled amount in XLM, what the payers paid (the commission included).',
    example: '2140.25',
  })
  volume!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The window's settled amount in USD with two decimals, valued at XLM's current reference price on NEAR Intents (an indicative figure at today's price). " +
      "Null only when there is something settled and NEAR Intents' prices could not be read.",
    example: '535.06',
  })
  volumeUsd!: string | null;
  @ApiProperty({
    description:
      'Commission the settled payments paid to Cosmos Pay, in XLM (0.18% of each).',
    example: '0.214025',
  })
  fees!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The window's commission in USD with two decimals, valued at XLM's current reference price on NEAR Intents (an indicative figure at today's price). " +
      "Null only when there is something settled and NEAR Intents' prices could not be read.",
    example: '0.05',
  })
  feesUsd!: string | null;
}

@ApiSchema({
  description:
    'Private payments per bucket, with the totals of the window and of the window before; amounts in XLM.',
})
export class SeriesPrivatePaymentsEntity {
  @ApiProperty({
    type: [SeriesPrivatePaymentBucketEntity],
    description:
      'Private payments per bucket, on the same buckets as the payments, pre-seeded so a quiet bucket is a zero.',
  })
  buckets!: SeriesPrivatePaymentBucketEntity[];
  @ApiProperty({
    type: SeriesPrivatePaymentWindowEntity,
    description: 'The window the buckets cover.',
  })
  totals!: SeriesPrivatePaymentWindowEntity;
  @ApiProperty({
    type: SeriesPrivatePaymentWindowEntity,
    description: 'The window of the same length just before it, for growth.',
  })
  previous!: SeriesPrivatePaymentWindowEntity;
}

@ApiSchema({
  description:
    "The consumer's payments, swaps, liquidity operations, webhook deliveries and private payments grouped into UTC buckets of `period` (weeks start on Monday), with the totals of the window and of the window before.",
})
export class AnalyticsSeriesEntity {
  @ApiProperty({
    enum: ['day', 'week', 'month', 'year'],
    description:
      'How the buckets are grouped, as requested (`day` when omitted).',
    example: 'month',
  })
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
  @ApiProperty({
    type: SeriesPrivatePaymentsEntity,
    description:
      'Private payments (amounts hidden on-chain, /v1/zk-payments) on the network the key targets. They run on testnet only for now, so a production key counts none.',
  })
  zkPayments!: SeriesPrivatePaymentsEntity;
}

@ApiSchema({
  description:
    'Settled and in-flight payment intent amounts for one chain and asset.',
})
export class AssetBalanceEntity {
  @ApiProperty({
    enum: CHAINS,
    description: 'Chain the payment intents are on.',
    example: 'stellar',
  })
  chain!: string;
  @ApiProperty({
    description:
      "Asset code, or the chain's coin (XLM, SOL, MON) for the native asset.",
    example: 'XLM',
  })
  asset!: string;
  @ApiProperty({ description: 'Settled.', example: '10420.5' }) amount!: string;
  @ApiProperty({ description: 'In flight.', example: '120' }) pending!: string;
  @ApiProperty({
    description: 'Settled payment intents in this chain and asset.',
    example: 42,
  })
  count!: number;
}

@ApiSchema({
  description:
    "Settled and pending payment intent amounts per chain and asset, on the API key's network.",
})
export class AnalyticsBalancesEntity {
  @ApiProperty({
    type: [AssetBalanceEntity],
    description: 'One entry per chain and asset, largest settled amount first.',
  })
  data!: AssetBalanceEntity[];
  @ApiProperty({
    description: 'Number of entries in `data` (the list is not paged).',
    example: 3,
  })
  total!: number;
}

@ApiSchema({
  description:
    "One API request of the consumer, as this service logged it. The dashboard's own console calls are left out.",
})
export class ApiLogEntity {
  @ApiProperty({ description: 'Request log id.', example: 'clz9xlog00001' })
  id!: string;
  @ApiProperty({ description: 'HTTP method.', example: 'POST' })
  method!: string;
  @ApiProperty({
    description: 'Request path, without the query string.',
    example: '/v1/swaps',
  })
  path!: string;
  @ApiProperty({
    description: 'HTTP status code of the response.',
    example: 201,
  })
  statusCode!: number;
  @ApiProperty({
    description:
      'Time this service took to handle the request, in milliseconds.',
    example: 84,
  })
  durationMs!: number;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Client IP address, as this service saw it.',
    example: '203.0.113.7',
  })
  ip!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: "The request's `User-Agent` header. Null when it sent none.",
    example: 'curl/8.4.0',
  })
  userAgent!: string | null;

  @ApiProperty({
    enum: ['ok', 'pending', 'fail'],
    description: '`ok` below 400, `pending` for a 4xx and `fail` for a 5xx.',
    example: 'ok',
  })
  status!: string;

  @ApiProperty({
    description: 'When the request was logged (ISO 8601 date-time).',
    example: '2026-06-21T12:34:56.000Z',
  })
  at!: Date;
}

@ApiSchema({
  description: "A page of the consumer's API request log, newest first.",
})
export class ApiLogListEntity {
  @ApiProperty({
    type: [ApiLogEntity],
    description: 'The requests of this page, newest first.',
  })
  data!: ApiLogEntity[];

  @ApiProperty({
    description: 'Total matching rows, not the page length.',
    example: 41203,
  })
  total!: number;

  @ApiProperty({
    description: 'The page size applied (the `take` query parameter).',
    example: 100,
  })
  take!: number;

  @ApiProperty({
    description: 'Rows skipped before this page (the `skip` query parameter).',
    example: 0,
  })
  skip!: number;
}

@ApiSchema({
  description:
    "One webhook delivery to one of the consumer's endpoints. The payload is never included.",
})
export class WebhookLogEntity {
  @ApiProperty({ description: 'Webhook delivery id.', example: 'clz9xwd00001' })
  id!: string;
  @ApiProperty({
    description: 'Id of the webhook endpoint the delivery is for.',
    example: 'we_9z8a1b0000abcd1234efgh',
  })
  endpointId!: string;
  @ApiPropertyOptional({
    nullable: true,
    description: "The endpoint's URL.",
    example: 'https://acme.test/hooks',
  })
  url!: string | null;
  @ApiProperty({
    description: 'Type of the event delivered.',
    example: 'PAYMENT_INTENT_SUCCEEDED',
  })
  eventType!: string;
  @ApiProperty({
    description:
      'Stable id of the event, sent to the receiver for idempotency.',
    example: 'evt_2c3d4e5f-aaaa-bbbb-cccc-1234567890ab',
  })
  eventId!: string;
  @ApiProperty({ description: 'Delivery attempts made.', example: 1 })
  attempts!: number;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'HTTP status the endpoint answered on the last attempt. Null when no attempt has finished or the last one got no response.',
    example: 200,
  })
  responseStatus!: number | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Why the last attempt failed. Null when the delivery succeeded or no attempt has finished.',
    example: null,
  })
  error!: string | null;

  @ApiProperty({
    enum: ['ok', 'pending', 'fail'],
    description:
      '`ok` when delivered, `fail` when failed, `pending` otherwise.',
    example: 'ok',
  })
  status!: string;

  @ApiProperty({
    description:
      'When the delivery was last attempted, or when it was created if never (ISO 8601 date-time).',
    example: '2026-06-21T12:34:57.000Z',
  })
  at!: Date;

  // `payload` is deliberately absent — see WebhookDeliveryEntity. This route is
  // gated on `webhooks:read` and a RECEIVER_UPDATED body is a KYC dossier.
}

@ApiSchema({
  description:
    'A page of the webhook deliveries to every endpoint of the consumer, newest first.',
})
export class WebhookLogListEntity {
  @ApiProperty({
    type: [WebhookLogEntity],
    description: 'The deliveries of this page, newest created first.',
  })
  data!: WebhookLogEntity[];

  @ApiProperty({
    description: 'Total matching rows, not the page length.',
    example: 1204,
  })
  total!: number;

  @ApiProperty({
    description: 'The page size applied (the `take` query parameter).',
    example: 100,
  })
  take!: number;

  @ApiProperty({
    description: 'Rows skipped before this page (the `skip` query parameter).',
    example: 0,
  })
  skip!: number;
}
