import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { ZK_TX_HASH_RE } from '@/zk-payments/zk-payments.constants';

export class ConfirmZkPaymentDto {
  @ApiProperty({
    description:
      "The transaction of the confidential transfer that paid the merchant the payment's `netAmount` (64 hex).",
    example: '0bd74f4b2725dc4f5b1c4ddabd7f66d66ac5a613c20f8175f2893eb33e757477',
  })
  @Matches(ZK_TX_HASH_RE, {
    message: 'paymentTxHash must be a Stellar transaction hash (64 hex)',
  })
  paymentTxHash!: string;

  @ApiProperty({
    description:
      "The transaction of the confidential transfer that paid the fee account the payment's `feeAmount` (64 hex), from the same account.",
    example: '5f0e8a1d3c7b9e2f4a6c8d0b1e3f5a7c9d2b4e6f8a0c1d3e5f7a9b2c4d6e8f0a',
  })
  @Matches(ZK_TX_HASH_RE, {
    message: 'feeTxHash must be a Stellar transaction hash (64 hex)',
  })
  feeTxHash!: string;

  @ApiPropertyOptional({
    description:
      "Only for a payment with a merchant fee, and then required: the transaction of the confidential transfer that paid `merchantFee.wallet` the payment's `merchantFee.amount` (64 hex), from the same account.",
    example: '9c2e4a6b8d0f1e3c5a7b9d2f4e6a8c0b1d3f5e7a9c2b4d6f8e0a1c3e5b7d9f2a',
  })
  @IsOptional()
  @Matches(ZK_TX_HASH_RE, {
    message: 'merchantFeeTxHash must be a Stellar transaction hash (64 hex)',
  })
  merchantFeeTxHash?: string;
}
