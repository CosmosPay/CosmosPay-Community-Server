import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CrossChainSwapStatus } from '@generated/prisma/client';

export class QueryCrossChainSwapsDto {
  @ApiPropertyOptional({
    enum: CrossChainSwapStatus,
    description: 'Only cross-chain swaps in this status.',
  })
  @IsOptional()
  @IsEnum(CrossChainSwapStatus)
  status?: CrossChainSwapStatus;

  @ApiPropertyOptional({
    default: 20,
    maximum: 100,
    description: 'How many swaps to return per page (1 to 100).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take: number = 20;

  @ApiPropertyOptional({
    default: 0,
    description: 'How many swaps to skip before this page, for pagination.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;
}
