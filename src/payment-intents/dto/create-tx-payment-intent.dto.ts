import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { IsStellarAddress } from '../../common/validators/is-stellar-address.validator';

/**
 * SEP-7 `tx` request: the payer (`source`) is known, so we build the unsigned
 * TransactionEnvelope (XDR) and a `web+stellar:tx?xdr=...` URI for the wallet to
 * sign. `source` and `amount` are required to assemble the payment operation.
 */
export class CreateTxPaymentIntentDto {
  @ApiProperty({
    description: "Payer's Stellar account — the transaction source.",
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  @IsStellarAddress()
  source!: string;

  @ApiProperty({
    description: "Payee's Stellar account.",
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
  })
  @IsStellarAddress()
  destination!: string;

  @ApiProperty({
    description: 'Amount as a decimal string (max 7 decimals).',
    example: '120.1234567',
  })
  @IsString()
  @Matches(/^\d+(\.\d{1,7})?$/, {
    message: 'amount must be a positive decimal with up to 7 decimal places',
  })
  amount!: string;

  @ApiPropertyOptional({
    description: 'Asset code. Omit (or "XLM"/"native") for native lumens.',
    example: 'USDC',
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
    description:
      'SEP-7 `msg`: shown to the user in their wallet (≤ 300 chars).',
    example: 'Order #24',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  msg?: string;

  @ApiPropertyOptional({
    description:
      'SEP-7 `callback` where the wallet POSTs the signed XDR, e.g. `url:https://...`.',
    example: 'url:https://merchant.example.com/sep7/callback',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  callback?: string;
}
