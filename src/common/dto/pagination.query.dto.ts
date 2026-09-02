import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * The `take`/`skip` pair every list endpoint accepts.
 *
 * This decorator stack was copy-pasted verbatim across seven query DTOs, with
 * three different defaults and no shared ceiling — so "what is the maximum page
 * size" had seven answers and changing it meant finding all of them. Subclass
 * this and redeclare `take` only when a list genuinely needs a different
 * default.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 20, maximum: 100, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take: number = 20;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;
}

/**
 * A list whose default page is the maximum.
 *
 * For endpoints that were previously unbounded: callers that relied on getting
 * everything keep the response they had, up to the clamp, and `total` tells
 * them whether there is more.
 */
export class WidePaginationQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ default: 100, maximum: 100, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take: number = 100;
}
