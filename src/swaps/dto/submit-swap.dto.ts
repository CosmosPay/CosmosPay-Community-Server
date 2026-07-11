import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Hands back the signed transaction envelope for a swap so the service can relay
 * it to the Stellar network. The signed XDR must be the one the service built
 * (its transaction hash is verified against the stored swap before submission).
 */
export class SubmitSwapDto {
  @ApiProperty({
    description: 'The signed transaction envelope (base64 XDR).',
    example: 'AAAAAgAAAABx…(signed base64 XDR)…AAAAAAAAAAA=',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  signedXdr!: string;
}
