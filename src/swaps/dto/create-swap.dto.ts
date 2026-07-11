import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import { IsStellarAddress } from '../../common/validators/is-stellar-address.validator';
import { QuoteSwapDto } from './quote-swap.dto';

/**
 * A swap request: a quote plus the on-chain participants. We assemble the
 * unsigned transaction — a platform fee payment (in the source asset) followed by
 * the `PathPaymentStrictSend` — and return its XDR + SEP-7 `tx` URI + QR. The
 * customer signs in their wallet; the service never holds keys.
 */
export class CreateSwapDto extends QuoteSwapDto {
  @ApiProperty({
    description: 'Account paying for (and signing) the swap — the tx source.',
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  @IsStellarAddress()
  source!: string;

  @ApiPropertyOptional({
    description:
      'Account credited the destination asset. Defaults to `source` ' +
      '(a self-swap). Must already trust a non-native destination asset.',
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  @IsOptional()
  @IsStellarAddress()
  destination?: string;

  @ApiPropertyOptional({
    description:
      'Optional MEMO_ID (numeric uint64) echoed on-chain for reconciliation.',
    example: '123456789',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'memo must be a numeric MEMO_ID (uint64)' })
  memo?: string;
}
