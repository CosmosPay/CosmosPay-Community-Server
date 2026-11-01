import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

/** One stored event, as the feed returns it. */
@ApiSchema({
  description: 'One client event the consumer reported, as stored.',
})
export class ActivityEventEntity {
  @ApiProperty({
    description: 'Event id assigned by this service.',
    example: 'clz9xact00001',
  })
  id!: string;
  @ApiProperty({
    description:
      'Which client reported the event: `wallet`, `dashboard`, `server` or `sdk` (`sdk` when it sent none).',
    example: 'wallet',
  })
  source!: string;
  @ApiProperty({
    description:
      'Severity: `debug`, `info`, `warn` or `error` (`info` when the client sent none).',
    example: 'error',
  })
  level!: string;
  @ApiProperty({
    description:
      'Coarse grouping the client gave the event (`event` when it sent none).',
    example: 'transaction',
  })
  category!: string;
  @ApiProperty({
    description: 'Event name, e.g. `payment.sent`.',
    example: 'payment.sent',
  })
  type!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Human-readable detail, cut to 500 characters at ingest. Null when the client sent none.',
    example: 'op_no_trust',
  })
  message!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Anonymous id grouping one run of the app, as the client sent it. Not an account id.',
    example: 's_9f2a1c',
  })
  sessionId!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Anonymous id for one install, as the client sent it. Not an account id.',
    example: 'd_41b0c8',
  })
  distinctId!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Version of the app that reported the event.',
    example: '1.5.0',
  })
  appVersion!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Platform the client runs on, as it sent it (e.g. `web`, `ext`, `app`, `desktop`, `dashboard`, `node`).',
    example: 'ext',
  })
  platform!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Network the event happened on, as the client sent it.',
    example: 'testnet',
  })
  network!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Duration of the measured operation in milliseconds, for a timing metric.',
    example: 812,
  })
  durationMs!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'Structured detail the client attached. `{ "_dropped": "props_too_large" }` when it was over 8,192 bytes serialized.',
    example: { asset: 'XLM', amount: '12.5' },
  })
  props!: Record<string, unknown> | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'IP address of the client that reported the event.',
    example: '203.0.113.7',
  })
  ip!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "The reporting request's `User-Agent` header, cut to 300 characters.",
    example: 'CosmosWallet/1.5.0',
  })
  userAgent!: string | null;

  @ApiProperty({
    description: 'When the client says it happened.',
    example: '2026-09-06T12:34:56.000Z',
  })
  at!: Date;

  @ApiProperty({
    description: 'When this service received it (later for a queued batch).',
    example: '2026-09-06T12:35:10.000Z',
  })
  receivedAt!: Date;
}

@ApiSchema({
  description:
    "A page of the consumer's client events matching the filters, newest first.",
})
export class ActivityEventListEntity {
  @ApiProperty({
    type: [ActivityEventEntity],
    description: 'The events of this page, newest first by `at`.',
  })
  data!: ActivityEventEntity[];

  @ApiProperty({
    description: 'Total matching rows, not the page length.',
    example: 4120,
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
    'What an ingest call wrote: the events accepted and the duplicates skipped.',
})
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

@ApiSchema({
  description: 'The number of events in the window with one value of a field.',
})
export class ActivityCountEntity {
  @ApiProperty({
    description:
      'The value counted: a level, source, category, event type or error message, depending on the list.',
    example: 'error',
  })
  key!: string;
  @ApiProperty({
    description: 'Events in the window with that value.',
    example: 12,
  })
  count!: number;
}

@ApiSchema({
  description: 'Client events on one UTC day of the rollup window.',
})
export class ActivitySeriesPointEntity {
  @ApiProperty({
    description: 'The UTC day, `YYYY-MM-DD`.',
    example: '2026-09-06',
  })
  date!: string;
  @ApiProperty({
    description: 'Events in the window that occurred that day (by `at`).',
    example: 128,
  })
  count!: number;
  @ApiProperty({
    description: 'Of those, the events at level `error`.',
    example: 4,
  })
  errors!: number;
}

@ApiSchema({
  description:
    'Rollup of the client events this consumer reported over the last `days` days, optionally for one `source`.',
})
export class ActivitySummaryEntity {
  @ApiProperty({ description: 'Events in the window.', example: 4120 })
  total!: number;

  @ApiProperty({
    description: 'Distinct `sessionId`s in the window: app runs, not accounts.',
    example: 318,
  })
  sessions!: number;

  @ApiProperty({
    description:
      'Distinct `distinctId`s in the window: installs, not accounts.',
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
    description: 'Most frequent error messages: what to fix first.',
  })
  topErrors!: ActivityCountEntity[];

  @ApiProperty({
    type: [ActivitySeriesPointEntity],
    description: 'Daily buckets, pre-seeded so a quiet day is a zero.',
  })
  series!: ActivitySeriesPointEntity[];
}
