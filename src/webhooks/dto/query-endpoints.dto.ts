import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Page bounds for the endpoint list, which was previously an unbounded read of
 * every endpoint the consumer had ever registered. The response is the standard
 * `{ data, total, take, skip }` envelope, so `total` tells the caller whether
 * `skip` has more pages to fetch.
 */
export class QueryEndpointsDto {
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
