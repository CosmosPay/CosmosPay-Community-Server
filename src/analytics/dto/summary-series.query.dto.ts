import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  SERIES_PERIODS,
  type SeriesPeriod,
} from '@/analytics/analytics.constants';

/** `GET /v1/summary/series?period=`: how to group payments, swaps, liquidity and webhooks; a day by default. */
export class SummarySeriesQueryDto {
  @ApiPropertyOptional({
    enum: Object.keys(SERIES_PERIODS),
    default: 'day',
    description:
      'day: 30 days, week: 12 weeks, month: 12 months, year: 5 years.',
  })
  @IsOptional()
  @IsIn(Object.keys(SERIES_PERIODS))
  period?: SeriesPeriod;
}
