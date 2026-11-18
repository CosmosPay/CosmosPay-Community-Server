import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { SWAP_CHAINS, type SwapChain } from '@/chains/chains.constants';
import { SwapStatus } from '@generated/prisma/client';

export class QuerySwapsDto {
  @ApiPropertyOptional({
    enum: SWAP_CHAINS,
    default: 'stellar',
    description:
      'Which chain to list. Omitted means Stellar. Only chains with a swap route (not Arc).',
  })
  @IsOptional()
  @IsIn(SWAP_CHAINS)
  chain?: SwapChain;

  @ApiPropertyOptional({
    enum: SwapStatus,
    description: 'Only swaps in this status.',
  })
  @IsOptional()
  @IsEnum(SwapStatus)
  status?: SwapStatus;

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
