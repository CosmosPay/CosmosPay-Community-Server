import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { MerchantFeeDto } from '@/common/merchant-fee/merchant-fee.dto';
import { CHAINS, type Chain } from '@/chains/chains.constants';
import { IsChainAddress } from '@/common/validators/is-chain-address.validator';
import { IsDecimalAmount } from '@/common/validators/is-decimal-amount.validator';
import {
  CHECKOUT_THEMES,
  type CheckoutTheme,
  DEFAULT_CHECKOUT_THEME,
} from '@/payment-intents/payment-intents.constants';

/**
 * A `pay` request: no payer is known, so the intent is a payment link the
 * payer's wallet opens —
 *
 *   - Stellar: a SEP-7 `web+stellar:pay?destination=...` URI;
 *   - Solana: a Solana Pay transfer request (`solana:<recipient>?...`) with a
 *     fresh `reference` key the payment is found by;
 *   - Monad: an EIP-681 URI (`ethereum:<payee>@143?value=...`).
 */
export class CreatePayPaymentIntentDto {
  @ApiPropertyOptional({
    enum: CHAINS,
    default: 'stellar',
    description:
      'Chain the payment settles on. Omit for Stellar. The network (mainnet ' +
      'or test network) is the one your API key is for, as on Stellar.',
  })
  @IsOptional()
  @IsIn(CHAINS)
  chain?: Chain;

  @ApiProperty({
    description:
      "Payee's account on the chain: Stellar G…, Solana base58, Monad 0x….",
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
  })
  @IsChainAddress('chain')
  destination!: string;

  @ApiPropertyOptional({
    description:
      'Amount the destination should receive, in the asset’s own units (XLM, ' +
      'SOL, MON, or the token). Omit to let the user enter it (e.g. ' +
      'donations), but not on Monad, where the amount is part of how the payment ' +
      'is recognised. At most 7 decimals on Stellar; elsewhere, at most the ' +
      'asset’s own decimals.',
    example: '120.1234567',
  })
  @IsOptional()
  @IsString()
  @IsDecimalAmount('chain')
  amount?: string;

  @ApiPropertyOptional({
    description:
      'Asset code the destination receives. Omit for the chain’s coin (XLM, ' +
      'SOL, MON). For a Solana or Monad token, the ticker it is labelled with, ' +
      'alongside `assetIssuer`.',
    example: 'USDC',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9]{1,12}$/, {
    message: 'assetCode must be 1-12 alphanumeric characters',
  })
  assetCode?: string;

  @ApiPropertyOptional({
    description:
      'Stellar: the issuer account. Solana: the SPL mint. Monad: the ERC-20 ' +
      'contract. Omit for the chain’s coin.',
    example: 'GCRCUE2C5TBNIPYHMEP7NK5RWTT2WBSZ75CMARH7GDOHDDCQH3XANFOB',
  })
  @IsOptional()
  @IsChainAddress('chain')
  assetIssuer?: string;

  @ApiPropertyOptional({
    description:
      'MEMO_ID (numeric uint64): the idempotency key on every chain, and on ' +
      'Stellar the on-chain identification too (on Solana it is recorded with ' +
      'the SPL Memo program). Auto-generated when omitted.',
    example: '123456789',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'memo must be a numeric MEMO_ID (uint64)' })
  memo?: string;

  @ApiPropertyOptional({
    description:
      'Shown to the user in their wallet (≤ 300 chars): SEP-7 `msg` on ' +
      'Stellar, the Solana Pay `message`. Not supported on Monad.',
    example: 'pay me with lumens',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  msg?: string;

  @ApiPropertyOptional({
    description: 'SEP-7 `callback`, e.g. `url:https://...`. Stellar only.',
    example: 'url:https://merchant.example.com/sep7/callback',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  callback?: string;

  @ApiPropertyOptional({
    enum: CHECKOUT_THEMES,
    default: DEFAULT_CHECKOUT_THEME,
    description:
      'Design of the hosted checkout page (`https://payments.cosmospay.lat/<id>`) ' +
      'for this intent. Omit for `classic`. Cosmetic: it is not part of the ' +
      'payment, so `PATCH /v1/payment-intents/{id}` can change it later, and a ' +
      'retry with the same memo returns the stored intent with its stored ' +
      'design.',
    example: 'ticket',
  })
  @IsOptional()
  @IsIn(CHECKOUT_THEMES)
  checkoutTheme?: CheckoutTheme;

  @ApiPropertyOptional({
    type: MerchantFeeDto,
    description:
      'Only with an `amount`: your own fee on this payment, paid in its asset ' +
      'to `wallet` (an account on the link\x27s chain, not `destination`). ' +
      '`paidBy: recipient` takes the fee from `amount`; `payer` adds it on ' +
      'top. Stellar: a SEP-7 `pay` link pays one account, so `uri` is the ' +
      'hosted checkout, which asks for the payer and has ' +
      '`POST /v1/payment-links/{id}/transaction` build the envelope with ' +
      'both payments. Solana: `uri` is a Solana Pay transaction request ' +
      '(`/v1/payment-links/{id}/solana-pay`); a SOL fee goes to an existing ' +
      'account. Monad answers `merchant_fee_unsupported`.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MerchantFeeDto)
  merchantFee?: MerchantFeeDto;
}
