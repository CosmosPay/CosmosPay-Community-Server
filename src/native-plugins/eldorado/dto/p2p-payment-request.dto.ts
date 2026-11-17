import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  P2P_PAYMENT_REQUEST_DEFAULT_MINUTES,
  P2P_PAYMENT_REQUEST_MAX_DESCRIPTION,
  P2P_PAYMENT_REQUEST_MAX_MINUTES,
  P2P_PAYMENT_REQUEST_MIN_MINUTES,
} from '@/native-plugins/eldorado/eldorado.constants';

/** Local money: digits with up to 18 decimals; the service holds it to two, like a purchase. */
const AMOUNT_RE = /^(0|[1-9]\d{0,17})(\.\d{1,18})?$/;
/** An EVM account or token contract: 0x and 40 hex digits, any case (stored EIP-55). */
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
/** The marketplace's ids for currencies and payment methods: short, plain. */
const MARKET_ID_RE = /^[A-Za-z0-9_-]+$/;
/**
 * One line a payer reads: no control character (a line break included), no line
 * or paragraph separator, and no bidirectional mark, override or isolate, which
 * would make the payer's page read differently from what the seller typed.
 */
const SINGLE_LINE_RE =
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  /^[^\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]*$/;

@ApiSchema({
  description:
    'A charge in local money shown as a QR: what the payer pays, in which token it reaches you, on which chain and at which address.',
})
export class CreateP2pPaymentRequestDto {
  @ApiProperty({
    example: 'ARS',
    description:
      'Local currency the payer pays in: an `id` of `GET /v1/onramp/p2p/market`.',
  })
  @IsString()
  @MaxLength(16)
  @Matches(MARKET_ID_RE, {
    message: 'currency must be a currency id from the market',
  })
  currency!: string;

  @ApiProperty({
    example: '15000',
    description:
      'What the payer pays, in local money: a decimal string with at most two decimals, at least the currency’s `minAmount`.',
  })
  @IsString()
  @Matches(AMOUNT_RE, { message: 'amount must be a decimal string' })
  amount!: string;

  @ApiProperty({
    example: 42161,
    description:
      'EIP-155 id of the chain the token is delivered on: a `chainId` of the market’s `networks`.',
  })
  @Type(() => Number)
  @IsInt({ message: 'chainId must be an EIP-155 chain id from the market' })
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  chainId!: number;

  @ApiProperty({
    example: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    description:
      'The token you receive: its contract `address` on `chainId`, from `GET /v1/onramp/p2p/tokens?chainId=` (the zero address is the chain’s own coin).',
  })
  @IsString()
  @Matches(EVM_ADDRESS_RE, {
    message:
      'token must be a token contract address (0x and 40 hex digits; the zero address for the chain’s own coin)',
  })
  token!: string;

  @ApiProperty({
    example: '0x52908400098527886E0F7030069857D2E4169EE7',
    description:
      'Your EVM account on `chainId`, where the token is delivered. Fixed in every purchase opened to pay this request.',
  })
  @IsString()
  @Matches(EVM_ADDRESS_RE, {
    message: 'address must be an EVM address (0x and 40 hex digits)',
  })
  address!: string;

  @ApiPropertyOptional({
    example: 'Table 4',
    minLength: 1,
    maxLength: P2P_PAYMENT_REQUEST_MAX_DESCRIPTION,
    description: `Shown to the payer under the amount: one line, 1 to ${P2P_PAYMENT_REQUEST_MAX_DESCRIPTION} characters once trimmed, no control or bidirectional characters.`,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(P2P_PAYMENT_REQUEST_MAX_DESCRIPTION)
  @Matches(SINGLE_LINE_RE, {
    message:
      'description must be one line, without control or bidirectional characters',
  })
  description?: string;

  @ApiPropertyOptional({
    example: P2P_PAYMENT_REQUEST_DEFAULT_MINUTES,
    default: P2P_PAYMENT_REQUEST_DEFAULT_MINUTES,
    minimum: P2P_PAYMENT_REQUEST_MIN_MINUTES,
    maximum: P2P_PAYMENT_REQUEST_MAX_MINUTES,
    description: `How long the request can be paid, in minutes (${P2P_PAYMENT_REQUEST_MIN_MINUTES} to ${P2P_PAYMENT_REQUEST_MAX_MINUTES}; a day by default).`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(P2P_PAYMENT_REQUEST_MIN_MINUTES)
  @Max(P2P_PAYMENT_REQUEST_MAX_MINUTES)
  expiresInMinutes?: number;
}

/** What the payer chooses when they start paying. */
@ApiSchema({
  description:
    'How the payer pays: one of the request’s `paymentMethods`, from its public read.',
})
export class OpenP2pPaymentRequestSessionDto {
  @ApiProperty({
    example: 'bank_tx_ar',
    description:
      'One of the `paymentMethods` `GET /v1/payment-links/fiat/{id}` answers.',
  })
  @IsString()
  @MaxLength(64)
  @Matches(MARKET_ID_RE, {
    message: 'paymentMethod must be a payment method id from the request',
  })
  paymentMethod!: string;
}

export class P2pPaymentRequestParamsDto {
  @ApiProperty({
    example: 'cmh4x2k9a0001l70g8v5q3z2w',
    description: 'Cosmos Pay id of the payment request.',
  })
  @IsString()
  @MaxLength(64)
  id!: string;
}
