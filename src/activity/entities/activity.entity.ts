import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One stored event, as the feed returns it. */
export class ActivityEventEntity {
  @ApiProperty({ example: 'clz9xact00001' }) id!: string;
  @ApiProperty({ example: 'wallet' }) source!: string;
  @ApiProperty({ example: 'error' }) level!: string;
  @ApiProperty({ example: 'transaction' }) category!: string;
  @ApiProperty({ example: 'payment.sent' }) type!: string;

  @ApiPropertyOptional({ nullable: true, example: 'op_no_trust' })
  message!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 's_9f2a1c' })
  sessionId!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'd_41b0c8' })
  distinctId!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '1.5.0' })
  appVersion!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'ext' })
  platform!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'testnet' })
  network!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 812 })
  durationMs!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    example: { asset: 'XLM', amount: '12.5' },
  })
  props!: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true, example: '203.0.113.7' })
  ip!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'CosmosWallet/1.5.0' })
  userAgent!: string | null;

  @ApiProperty({
    description: 'When the client says it happened.',
    example: '2026-09-06T12:34:56.000Z',
  })
  at!: Date;

  @ApiProperty({
    description: 'When this service received it — later for a queued batch.',
    example: '2026-09-06T12:35:10.000Z',
  })
  receivedAt!: Date;
}

export class ActivityEventListEntity {
  @ApiProperty({ type: [ActivityEventEntity] }) data!: ActivityEventEntity[];

  @ApiProperty({
    description: 'Total matching rows — not the page length.',
    example: 4120,
  })
  total!: number;

  @ApiProperty({ example: 100 }) take!: number;
  @ApiProperty({ example: 0 }) skip!: number;
}

export class ActivityIngestResultEntity {
  @ApiProperty({
    description: 'Events written.',
    example: 24,
  })
  accepted!: number;

  @ApiProperty({
    description:
      'Events dropped as duplicates of a batch already written. Never an error: ' +
      'a client that retries a flush it never saw acknowledged is doing the right thing.',
    example: 0,
  })
  duplicates!: number;
}

export class ActivityCountEntity {
  @ApiProperty({ example: 'error' }) key!: string;
  @ApiProperty({ example: 12 }) count!: number;
}

export class ActivitySeriesPointEntity {
  @ApiProperty({ example: '2026-09-06' }) date!: string;
  @ApiProperty({ example: 128 }) count!: number;
  @ApiProperty({ example: 4 }) errors!: number;
}

export class ActivitySummaryEntity {
  @ApiProperty({ description: 'Events in the window.', example: 4120 })
  total!: number;

  @ApiProperty({
    description:
      'Distinct `sessionId`s in the window — app runs, not accounts.',
    example: 318,
  })
  sessions!: number;

  @ApiProperty({
    description:
      'Distinct `distinctId`s in the window — installs, not accounts.',
    example: 96,
  })
  devices!: number;

  @ApiProperty({ type: [ActivityCountEntity], description: 'Count per level.' })
  levels!: ActivityCountEntity[];

  @ApiProperty({
    type: [ActivityCountEntity],
    description: 'Count per source.',
  })
  sources!: ActivityCountEntity[];

  @ApiProperty({
    type: [ActivityCountEntity],
    description: 'Count per category.',
  })
  categories!: ActivityCountEntity[];

  @ApiProperty({
    type: [ActivityCountEntity],
    description: 'Most frequent event types.',
  })
  topTypes!: ActivityCountEntity[];

  @ApiProperty({
    type: [ActivityCountEntity],
    description: 'Most frequent error messages — what to fix first.',
  })
  topErrors!: ActivityCountEntity[];

  @ApiProperty({
    type: [ActivitySeriesPointEntity],
    description: 'Daily buckets, pre-seeded so a quiet day is a zero.',
  })
  series!: ActivitySeriesPointEntity[];
}
