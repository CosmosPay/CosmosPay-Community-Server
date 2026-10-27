import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The transfer's transaction, signed. It must be the one the service built
 * (its hash is checked) and carry a signature before anything is relayed.
 */
export class SubmitUsdt0TransferDto {
  @ApiProperty({
    description: 'The signed transaction envelope (base64 XDR).',
    example: 'AAAAAgAAAABx…(signed base64 XDR)…AAAAAAAAAAA=',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  signedXdr!: string;
}
