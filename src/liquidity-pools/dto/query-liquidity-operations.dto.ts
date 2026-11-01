import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { LiquidityOperationKind, SwapStatus } from '@generated/prisma/client';

export class QueryLiquidityOperationsDto {
  @ApiPropertyOptional({
    enum: LiquidityOperationKind,
    description: 'Only operations of this kind (`DEPOSIT` or `WITHDRAW`).',
  })
  @IsOptional()
  @IsEnum(LiquidityOperationKind)
  kind?: LiquidityOperationKind;

  @ApiPropertyOptional({
    enum: SwapStatus,
    description: 'Only operations in this status.',
  })
  @IsOptional()
  @IsEnum(SwapStatus)
  status?: SwapStatus;

  @ApiPropertyOptional({
    default: 20,
    maximum: 100,
    description: 'How many operations to return per page (1 to 100).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take: number = 20;

  @ApiPropertyOptional({
    default: 0,
    description:
      'How many matching operations to skip before the page starts (newest first).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;
}
