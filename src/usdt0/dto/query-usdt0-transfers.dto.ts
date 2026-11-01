import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Usdt0TransferStatus } from '@generated/prisma/client';

export class QueryUsdt0TransfersDto {
  @ApiPropertyOptional({
    enum: Usdt0TransferStatus,
    description: 'Only transfers in this status, as last refreshed.',
  })
  @IsOptional()
  @IsEnum(Usdt0TransferStatus)
  status?: Usdt0TransferStatus;

  @ApiPropertyOptional({
    default: 20,
    maximum: 100,
    description: 'How many transfers to return per page (1 to 100).',
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
      'How many matching transfers to skip before the page starts (newest first).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;
}
