import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

export class ValidatePaymentIntentDto {
  @ApiProperty({
    description:
      'Hash of the submitted Stellar transaction to validate against this intent.',
    example: '3389e9f0d6b3e3f1c2a1...',
  })
  @IsString()
  @Length(64, 64, { message: 'txHash must be a 64-char hex transaction hash' })
  @Matches(/^[0-9a-fA-F]{64}$/, { message: 'txHash must be hexadecimal' })
  txHash!: string;
}
