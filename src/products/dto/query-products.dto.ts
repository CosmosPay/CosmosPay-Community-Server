import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Page bounds for the product list.
 *
 * The endpoint used to read the whole table and report `total: data.length`, so
 * a consumer could neither page nor learn how many products it had. `take`
 * defaults to its maximum, so callers that were relying on getting everything
 * keep the response they had up to the clamp — and `total` now tells them when
 * there is more.
 */
export class QueryProductsDto {
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
