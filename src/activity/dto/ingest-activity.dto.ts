import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ACTIVITY_MAX_BATCH } from '@/activity/activity.constants';

/** Which client reported an event. */
export const ACTIVITY_SOURCES = ['wallet', 'dashboard', 'server', 'sdk'];

/** Severity ladder. The views filter on it, so it is closed. */
export const ACTIVITY_LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * One reported event.
 *
 * `type` and `category` are deliberately free-form strings rather than enums:
 * a client that grows a new screen must be able to report it without a
 * migration and a coordinated deploy of three repositories. `level` and
 * `source` are closed, because the dashboard filters on them and a typo there
 * would make an event invisible rather than merely unfamiliar.
 */
export class ActivityEventDto {
  @ApiProperty({
    description:
      'Event name, e.g. `payment.sent`. Lowercase, dot/underscore/dash/colon separated.',
    example: 'payment.sent',
  })
  @IsString()
  @MaxLength(80)
  @Matches(/^[a-z0-9][a-z0-9._:-]*$/, {
    message:
      'type must be lowercase alphanumeric with . _ - : separators, e.g. payment.sent',
  })
  type!: string;

  @ApiPropertyOptional({
    description:
      "The client's own id for this event. Send one to make a flush retry safe: " +
      'a batch that was written but never acknowledged can be re-sent without ' +
      'doubling its rows.',
    example: '6f1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6071',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  eventId?: string;

  @ApiPropertyOptional({ enum: ACTIVITY_SOURCES, default: 'sdk' })
  @IsOptional()
  @IsIn(ACTIVITY_SOURCES)
  source?: string;

  @ApiPropertyOptional({ enum: ACTIVITY_LEVELS, default: 'info' })
  @IsOptional()
  @IsIn(ACTIVITY_LEVELS)
  level?: string;

  @ApiPropertyOptional({
    description:
      'Coarse grouping: error, metric, transaction, auth, navigation, api, lifecycle, ui.',
    example: 'transaction',
    default: 'event',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^[a-z0-9][a-z0-9._-]*$/, {
    message: 'category must be lowercase alphanumeric with . _ - separators',
  })
  category?: string;

  @ApiPropertyOptional({
    description:
      'Human-readable detail. Truncated rather than rejected when long — a ' +
      'telemetry call must not fail on the size of an error string.',
    example: 'op_no_trust',
  })
  @IsOptional()
  @IsString()
  message?: string;

  @ApiPropertyOptional({
    description: 'Anonymous id grouping one run of the app. Not an account id.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sessionId?: string;

  @ApiPropertyOptional({
    description: 'Anonymous id for one install. Not an account id.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  distinctId?: string;

  @ApiPropertyOptional({ example: '1.5.0' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  appVersion?: string;

  @ApiPropertyOptional({
    description: 'web | ext | app | desktop | dashboard | node',
    example: 'ext',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  platform?: string;

  @ApiPropertyOptional({ example: 'testnet' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  network?: string;

  @ApiPropertyOptional({
    description: 'Duration of the measured operation, for a timing metric.',
    example: 812,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  // A day. Past this the value is a bug (a clock jump, a timer that was never
  // stopped) and storing it would skew every average computed over the column.
  @Max(86_400_000)
  durationMs?: number;

  @ApiPropertyOptional({
    description:
      'Structured detail. Size-capped at ingest; never credentials, never a seed.',
    type: 'object',
    additionalProperties: true,
    example: { asset: 'XLM', amount: '12.5' },
  })
  @IsOptional()
  @IsObject()
  props?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'When the client says it happened. Clamped to the receipt time when the ' +
      'device clock is too far off. Defaults to receipt time.',
    example: '2026-09-06T12:34:56.000Z',
  })
  @IsOptional()
  @IsISO8601()
  occurredAt?: string;
}

export class IngestActivityDto {
  @ApiProperty({
    type: [ActivityEventDto],
    description: `Up to ${ACTIVITY_MAX_BATCH} events. Clients batch: a wallet queues while offline and flushes on the next launch.`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ACTIVITY_MAX_BATCH)
  @ValidateNested({ each: true })
  @Type(() => ActivityEventDto)
  events!: ActivityEventDto[];
}
