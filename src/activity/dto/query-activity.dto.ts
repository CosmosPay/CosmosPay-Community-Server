import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { WidePaginationQueryDto } from '@/common/dto/pagination.query.dto';
import {
  ACTIVITY_LEVELS,
  ACTIVITY_SOURCES,
} from '@/activity/dto/ingest-activity.dto';
import { ACTIVITY_SUMMARY_DEFAULT_DAYS } from '@/activity/activity.constants';

/**
 * Filters for the activity feed.
 *
 * Every one of them narrows a query that is already scoped to the caller's
 * consumer — there is no filter here that can widen it.
 */
export class QueryActivityDto extends WidePaginationQueryDto {
  @ApiPropertyOptional({ enum: ACTIVITY_SOURCES })
  @IsOptional()
  @IsIn(ACTIVITY_SOURCES)
  source?: string;

  @ApiPropertyOptional({
    enum: ACTIVITY_LEVELS,
    description:
      'Minimum severity, not an exact match: `warn` returns warnings and errors.',
  })
  @IsOptional()
  @IsIn(ACTIVITY_LEVELS)
  level?: string;

  @ApiPropertyOptional({ example: 'transaction' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;

  @ApiPropertyOptional({
    example: 'payment.',
    description: 'Prefix match on the event name.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  type?: string;

  @ApiPropertyOptional({ example: 'testnet' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  network?: string;

  @ApiPropertyOptional({
    description: 'Only events that occurred at or after this instant.',
    example: '2026-09-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  since?: string;

  @ApiPropertyOptional({
    description: 'Only events that occurred at or before this instant.',
    example: '2026-09-07T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  until?: string;
}

/** Window for the rollup. */
export class ActivitySummaryQueryDto {
  @ApiPropertyOptional({
    default: ACTIVITY_SUMMARY_DEFAULT_DAYS,
    minimum: 1,
    maximum: 90,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days: number = ACTIVITY_SUMMARY_DEFAULT_DAYS;

  @ApiPropertyOptional({ enum: ACTIVITY_SOURCES })
  @IsOptional()
  @IsIn(ACTIVITY_SOURCES)
  source?: string;
}
