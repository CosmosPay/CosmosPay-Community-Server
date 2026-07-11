import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Hands back the signed transaction envelope for a liquidity pool operation so
 * the service can relay it. The signed XDR must be the one the service built
 * (its hash is verified against the stored operation before submission).
 */
export class SubmitLiquidityDto {
  @ApiProperty({
    description: 'The signed transaction envelope (base64 XDR).',
    example: 'AAAAAgAAAABx…(signed base64 XDR)…AAAAAAAAAAA=',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  signedXdr!: string;
}
