import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { QuoteCrossChainSwapDto } from '@/cross-chain-swaps/dto/quote-cross-chain-swap.dto';

export class CreateCrossChainSwapDto extends QuoteCrossChainSwapDto {
  @ApiPropertyOptional({
    description:
      'Idempotency key. The Idempotency-Key header takes precedence over this field.',
    example: 'xswap-2026-10-02-001',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotencyKey?: string;
}
