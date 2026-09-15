import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';
import { TX_HASH_RE } from '@/payment-intents/payment-intents.constants';

export class ValidatePaymentIntentDto {
  @ApiProperty({
    description:
      'Hash of the submitted Stellar transaction to validate against this intent.',
    example: '3389e9f0d6b3e3f1c2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9',
  })
  // Lowercased like `UpdatePaymentIntentDto.txHash`: a verified hash is what a
  // settled intent stores, and the (consumerId, txHash) index compares bytes.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsString()
  @Length(64, 64, { message: 'txHash must be a 64-char hex transaction hash' })
  @Matches(TX_HASH_RE, { message: 'txHash must be hexadecimal' })
  txHash!: string;
}
