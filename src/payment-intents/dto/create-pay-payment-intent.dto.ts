import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { IsStellarAddress } from '../../common/validators/is-stellar-address.validator';

/**
 * SEP-7 `pay` request: no payer is known, so we cannot build an XDR. We return a
 * `web+stellar:pay?destination=...` URI carrying the destination and any of the
 * optional payment fields. The wallet picks the source asset/path itself.
 */
export class CreatePayPaymentIntentDto {
  @ApiProperty({
    description: "Payee's Stellar account.",
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
  })
  @IsStellarAddress()
  destination!: string;

  @ApiPropertyOptional({
    description:
      'Amount the destination should receive. Omit to let the user enter it ' +
      '(e.g. donations).',
    example: '120.1234567',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d{1,7})?$/, {
    message: 'amount must be a positive decimal with up to 7 decimal places',
  })
  amount?: string;

  @ApiPropertyOptional({
    description: 'Asset code the destination receives. Omit for native lumens (XLM).',
    example: 'USD',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9]{1,12}$/, {
    message: 'assetCode must be 1-12 alphanumeric characters',
  })
  assetCode?: string;

  @ApiPropertyOptional({
    description: 'Issuer account for a non-native asset.',
    example: 'GCRCUE2C5TBNIPYHMEP7NK5RWTT2WBSZ75CMARH7GDOHDDCQH3XANFOB',
  })
  @IsOptional()
  @IsStellarAddress()
  assetIssuer?: string;

  @ApiPropertyOptional({
    description:
      'MEMO_ID (numeric uint64) for idempotency + on-chain identification. ' +
      'Auto-generated when omitted.',
    example: '123456789',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'memo must be a numeric MEMO_ID (uint64)' })
  memo?: string;

  @ApiPropertyOptional({
    description: 'SEP-7 `msg`: shown to the user in their wallet (≤ 300 chars).',
    example: 'pay me with lumens',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  msg?: string;

  @ApiPropertyOptional({
    description: 'SEP-7 `callback`, e.g. `url:https://...`.',
    example: 'url:https://merchant.example.com/sep7/callback',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  callback?: string;
}
