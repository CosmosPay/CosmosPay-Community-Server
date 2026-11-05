import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

/** Local money, as the marketplace takes it: digits with at most two decimals, a dot as separator. */
const FIAT_AMOUNT_RE = /^(0|[1-9]\d{0,14})(\.\d{1,2})?$/;
/** An EVM account: 0x and 40 hex digits, any case (stored EIP-55). */
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
/** The marketplace's ids for currencies and payment methods: short, plain. */
const MARKET_ID_RE = /^[A-Za-z0-9_-]+$/;

@ApiSchema({
  description:
    'A purchase of a stablecoin with local money: what is paid, how, what is bought and where it is delivered.',
})
export class P2pOrderDto {
  @ApiProperty({
    example: 'ARS',
    description:
      'Local currency paid, an `id` from `GET /v1/onramp/p2p/market`.',
  })
  @IsString()
  @MaxLength(16)
  @Matches(MARKET_ID_RE, {
    message: 'currency must be a currency id from the market',
  })
  currency!: string;

  @ApiProperty({
    example: 'bank_tx_ar',
    description:
      'How the buyer pays: one of that currency’s `paymentMethods` in the market.',
  })
  @IsString()
  @MaxLength(64)
  @Matches(MARKET_ID_RE, {
    message: 'paymentMethod must be a payment method id from the market',
  })
  paymentMethod!: string;

  @ApiProperty({
    example: 'USDC',
    description: 'Stablecoin bought: a `symbol` from the market’s `tokens`.',
  })
  @IsString()
  @MaxLength(16)
  @Matches(MARKET_ID_RE, {
    message: 'token must be a token symbol from the market',
  })
  token!: string;

  @ApiProperty({
    example: '50000',
    description:
      'Local money to pay, a decimal string with at most two decimals; at least the currency’s `minAmount`.',
  })
  @IsString()
  @Matches(FIAT_AMOUNT_RE, {
    message: 'amount must be a decimal string with at most two decimals',
  })
  amount!: string;

  @ApiProperty({
    example: '0x52908400098527886E0F7030069857D2E4169EE7',
    description:
      'The EVM account the stablecoin is delivered to, on the market’s `chain`.',
  })
  @IsString()
  @Matches(EVM_ADDRESS_RE, {
    message: 'address must be an EVM address (0x and 40 hex digits)',
  })
  address!: string;
}

export class P2pSessionParamsDto {
  @ApiProperty({
    example: 'clz9xp2p0001',
    description: 'Cosmos Pay id of the session.',
  })
  @IsString()
  @MaxLength(64)
  id!: string;
}
