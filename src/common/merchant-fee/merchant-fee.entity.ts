import { ApiProperty } from '@nestjs/swagger';
import {
  MERCHANT_FEE_PAYERS,
  type MerchantFeePayer,
} from '@/common/merchant-fee/merchant-fee.constants';

/** The merchant fee an operation charged, as its row records it. */
export class MerchantFeeEntity {
  @ApiProperty({
    description: 'The percentage part, in basis points.',
    example: 150,
  })
  bps!: number;

  @ApiProperty({ description: 'The fixed part, in `asset`.', example: '0.25' })
  fixed!: string;

  @ApiProperty({
    description:
      'The fee charged: the percentage of `amount` plus the fixed part.',
    example: '1.75',
  })
  amount!: string;

  @ApiProperty({ description: 'The asset the fee is paid in.', example: 'XLM' })
  asset!: string;

  @ApiProperty({
    description: 'Where the fee is paid.',
    example: 'GBDHAQXQQ75WVBUZ2IX3O7ME7JOKJUOUPUXRNDCORUJODWQCTVUEQ62R',
  })
  wallet!: string;

  @ApiProperty({
    enum: MERCHANT_FEE_PAYERS,
    description:
      '`recipient`: deducted from the amount. `payer`: added on top of it.',
    example: 'recipient',
  })
  paidBy!: MerchantFeePayer;
}
