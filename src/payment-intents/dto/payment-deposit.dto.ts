import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { MAX_TOKEN_DECIMALS } from '@/chains/chains.constants';
import {
  CROSS_CHAIN_NETWORK_IDS,
  type CrossChainNetworkId,
} from '@/cross-chain-swaps/cross-chain-swaps.constants';
import { IsCrossChainAddress } from '@/cross-chain-swaps/is-cross-chain-address.validator';
import {
  RECEIPT_LANGS,
  type ReceiptLang,
} from '@/payment-intents/payment-intents.constants';

/**
 * What a payer pays a payment link with, from any network: the asset they
 * send and where a refund goes. The quote and the deposit take the same three
 * fields, so the deposit made is the one the payer was quoted.
 */
@ApiSchema({
  description:
    'How a payer pays a payment link from any network: the asset sent and the ' +
    'address a refund goes to, on that network.',
})
export class PaymentDepositRequestDto {
  @ApiProperty({
    enum: CROSS_CHAIN_NETWORK_IDS,
    example: 'tron',
    description:
      'The network the payer sends from: a `chain` from ' +
      '`GET /v1/payment-links/{id}/deposit-assets`.',
  })
  @IsIn(CROSS_CHAIN_NETWORK_IDS)
  originChain!: CrossChainNetworkId;

  @ApiProperty({
    description:
      'The asset sent: "native" or the native ticker (TRX, ETH, BTC), a symbol ' +
      'listed once on that network (USDT), its contract, or Stellar ' +
      'CODE:ISSUER. See `GET /v1/payment-links/{id}/deposit-assets`.',
    example: 'USDT',
  })
  @IsString()
  @Length(1, 128)
  originAsset!: string;

  @ApiProperty({
    description:
      'Where the deposit is refunded if the payment cannot complete (or the ' +
      'surplus of an overpayment), on originChain: normally the paying wallet.',
    example: 'TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy',
  })
  @IsCrossChainAddress('originChain')
  refundTo!: string;

  @ApiPropertyOptional({
    description:
      'Only for a link with no fixed amount: what the merchant should receive, ' +
      "in the link's asset, as the payer typed it. The quote pays exactly it; " +
      'a link with an amount refuses another one.',
    example: '25',
  })
  @IsOptional()
  @IsString()
  @Matches(new RegExp(`^\\d+(\\.\\d{1,${MAX_TOKEN_DECIMALS}})?$`), {
    message: `amount must be a positive decimal with up to ${MAX_TOKEN_DECIMALS} decimal places`,
  })
  amount?: string;
}

/**
 * A deposit request: what the quote takes, plus the payer's email, which the
 * hosted checkout asks for before it offers any way to pay. The receipt goes
 * there when this deposit settles the link.
 */
@ApiSchema({
  description:
    'Opens a deposit address for one payer: the asset sent, the refund ' +
    'address, and the email the receipt goes to.',
})
export class CreatePaymentDepositDto extends PaymentDepositRequestDto {
  @ApiProperty({
    description:
      "The payer's email, as typed in the checkout (not verified): the receipt " +
      'goes there when the payment succeeds, and the merchant sees it on the ' +
      'payment.',
    example: 'payer@example.com',
  })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiPropertyOptional({
    enum: RECEIPT_LANGS,
    default: 'en',
    description:
      "The language of the payer's checkout: the receipt is written in it.",
  })
  @IsOptional()
  @IsIn(RECEIPT_LANGS)
  lang?: ReceiptLang;
}

/** The payer's contact, recorded by the checkout before it shows how to pay. */
@ApiSchema({
  description:
    "The payer's email (and checkout language), recorded before the hosted " +
    'checkout shows how to pay: the receipt goes there.',
})
export class PayerContactDto {
  @ApiProperty({
    description: "The payer's email, as typed in the checkout (not verified).",
    example: 'payer@example.com',
  })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiPropertyOptional({
    enum: RECEIPT_LANGS,
    default: 'en',
    description:
      "The language of the payer's checkout: the receipt is written in it.",
  })
  @IsOptional()
  @IsIn(RECEIPT_LANGS)
  lang?: ReceiptLang;
}
