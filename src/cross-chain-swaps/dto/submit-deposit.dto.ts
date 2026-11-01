import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

@ApiSchema({
  description:
    "Reports the transaction that paid a cross-chain swap's deposit address, " +
    'so NEAR Intents can start the swap without waiting for its indexer.',
})
export class SubmitDepositDto {
  @ApiProperty({
    description:
      "The transaction that paid the deposit address, in the origin chain's " +
      'own spelling: a 64-hex hash on Stellar and the UTXO chains, 0x + 64 hex ' +
      'on EVM networks, a base58 signature on Solana. A 400 names the shape ' +
      'the origin chain expects.',
    example: '5f0e8a1d3c7b9e2f4a6c8d0b1e3f5a7c9d2b4e6f8a0c1d3e5f7a9b2c4d6e8f0a',
  })
  @IsString()
  @Length(1, 128)
  txHash!: string;
}
