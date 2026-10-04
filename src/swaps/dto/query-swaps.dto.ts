import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CHAINS, type Chain } from '@/chains/chains.constants';
import { SwapStatus } from '@generated/prisma/client';

export class QuerySwapsDto {
  @ApiPropertyOptional({
    enum: CHAINS,
    default: 'stellar',
    description: 'Which chain to list. Omitted means Stellar.',
  })
  @IsOptional()
  @IsIn(CHAINS)
  chain?: Chain;

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
