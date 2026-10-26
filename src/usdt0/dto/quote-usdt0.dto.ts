import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { IsDecimalAmount } from '@/common/validators/is-decimal-amount.validator';
import { IsStellarAddress } from '@/common/validators/is-stellar-address.validator';
import { USDT0_CHAIN_IDS, type Usdt0ChainId } from '@/usdt0/usdt0.constants';

/**
 * A USDT0 quote: how much USDT0 to send from Stellar, and to which network.
 * Persists nothing; the OFT is asked by simulation.
 */
export class QuoteUsdt0Dto {
  @ApiProperty({
    enum: USDT0_CHAIN_IDS,
    example: 'eth',
    description:
      'The destination network (`GET /v1/usdt0/routes`). `eth` receives ' +
      'native USDT; every other network receives USDT0.',
  })
  @IsIn(USDT0_CHAIN_IDS)
  to!: Usdt0ChainId;

  @ApiProperty({
    example: '12.5',
    description:
      'USDT0 to send, decimal with up to 7 places. The OFT carries 6: a 7th ' +
      'decimal is dust that stays in the account (see `dust`).',
  })
  @IsString()
  @IsDecimalAmount()
  amount!: string;

  @ApiPropertyOptional({
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    description:
      'The account that would send it: the quote is simulated as that account. ' +
      'Omitted, a fixed mainnet account is used; the price is the same.',
  })
  @IsOptional()
  @IsStellarAddress()
  source?: string;
}
