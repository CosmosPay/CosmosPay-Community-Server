import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MerchantFeeDto } from '@/common/merchant-fee/merchant-fee.dto';
import { IsDecimalAmount } from '@/common/validators/is-decimal-amount.validator';
import { IsStellarAddress } from '@/common/validators/is-stellar-address.validator';
import {
  ZK_PAYMENT_DEFAULT_EXPIRES_IN_MINUTES,
  ZK_PAYMENT_DESCRIPTION_MAX_LENGTH,
  ZK_PAYMENT_IDEMPOTENCY_KEY_MAX_LENGTH,
  ZK_PAYMENT_MAX_EXPIRES_IN_MINUTES,
} from '@/zk-payments/zk-payments.constants';

@ApiSchema({
  description:
    'Request to create a private payment: an amount in XLM that the payer pays ' +
    'to `recipient` with confidential transfers, which hide it on-chain.',
})
export class CreateZkPaymentDto {
  @ApiProperty({
    description:
      'What the payer pays in total, in XLM (up to 7 decimal places). The ' +
      'merchant receives it minus the 0.18% commission (`netAmount`); the ' +
      'commission (`feeAmount`, rounded up, at least one stroop) goes to ' +
      "Cosmos Pay's fee account. An amount whose net would be zero is refused.",
    example: '25.5',
  })
  @IsDecimalAmount()
  amount!: string;

  @ApiProperty({
    description:
      "The merchant's Stellar account (G...). It must already hold a " +
      "confidential account on Cosmos Pay's token, registered under auditor " +
      'id 0; otherwise the payment is refused with `recipient_not_registered`.',
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
  })
  @IsStellarAddress()
  recipient!: string;

  @ApiPropertyOptional({
    description:
      'Shown to the payer by the checkout. Not secret, and not on-chain: the ' +
      'public read returns it to anyone holding the payment id.',
    example: 'Order #24',
    maxLength: ZK_PAYMENT_DESCRIPTION_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(ZK_PAYMENT_DESCRIPTION_MAX_LENGTH)
  description?: string;

  @ApiPropertyOptional({
    description:
      'How long the payment stays payable, in minutes. Both transfers must ' +
      'close before it ends.',
    default: ZK_PAYMENT_DEFAULT_EXPIRES_IN_MINUTES,
    minimum: 1,
    maximum: ZK_PAYMENT_MAX_EXPIRES_IN_MINUTES,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ZK_PAYMENT_MAX_EXPIRES_IN_MINUTES)
  expiresInMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Idempotency key. A retry with the same key and the same request ' +
      'returns the existing payment; the same key with a different request is ' +
      '409 idempotency_conflict. The Idempotency-Key header takes precedence ' +
      'over this field. One is generated when neither is sent.',
    example: 'order-24',
    maxLength: ZK_PAYMENT_IDEMPOTENCY_KEY_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(ZK_PAYMENT_IDEMPOTENCY_KEY_MAX_LENGTH)
  idempotencyKey?: string;

  @ApiPropertyOptional({
    type: MerchantFeeDto,
    description:
      'Your own fee on this payment, in XLM, paid privately like the rest: a ' +
      'third confidential transfer from the payer to `wallet`, which must ' +
      "already hold a confidential account on Cosmos Pay's token (under " +
      'auditor id 0) and be neither the recipient nor the fee account. ' +
      '`paidBy: recipient` takes it from `amount` (the merchant receives ' +
      'less); `payer` adds it on top (the payer pays `amount` plus the fee). ' +
      'The 0.18% commission is a share of `amount` either way. Confirm then ' +
      'takes `merchantFeeTxHash` too.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MerchantFeeDto)
  merchantFee?: MerchantFeeDto;
}
