import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  LiquidityOperationKind,
  SwapStatus,
} from '../../../generated/prisma/client';

export class QueryLiquidityOperationsDto {
  @ApiPropertyOptional({ enum: LiquidityOperationKind })
  @IsOptional()
  @IsEnum(LiquidityOperationKind)
  kind?: LiquidityOperationKind;

  @ApiPropertyOptional({ enum: SwapStatus })
  @IsOptional()
  @IsEnum(SwapStatus)
  status?: SwapStatus;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take: number = 20;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;
}
