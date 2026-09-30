import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class SubmitDepositDto {
  @ApiProperty({
    description:
      'The transaction that paid the deposit address, on the origin chain: a ' +
      'Stellar hash (64 hex), a Solana signature (base58) or a Monad hash (0x + 64 hex).',
    example: '5f0e8a1d3c7b9e2f4a6c8d0b1e3f5a7c9d2b4e6f8a0c1d3e5f7a9b2c4d6e8f0a',
  })
  @IsString()
  @Length(1, 128)
  txHash!: string;
}
