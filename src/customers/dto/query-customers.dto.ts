import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Page bounds for the customer list.
 *
 * Bounding this list is not only about response size: the per-customer payment
 * stats are aggregated for the accounts on the page, so the page size is what
 * bounds the aggregation too. `take` defaults to its maximum so callers that
 * were relying on getting everything keep the response they had up to the
 * clamp, with `total` reporting the real row count.
 */
export class QueryCustomersDto {
  @ApiPropertyOptional({ default: 100, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take: number = 100;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;
}
