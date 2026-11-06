import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '@/common/dto/pagination.query.dto';
import {
  P2P_TOKENS_DEFAULT_TAKE,
  P2P_TOKENS_MAX_TAKE,
} from '@/native-plugins/eldorado/eldorado.constants';

/**
 * An order's amount: digits with up to 18 decimals, a dot as separator. The
 * service then holds a purchase (local money) to two decimals and a sale to the
 * token's own decimals.
 */
const AMOUNT_RE = /^(0|[1-9]\d{0,17})(\.\d{1,18})?$/;
/** An EVM account or token contract: 0x and 40 hex digits, any case (stored EIP-55). */
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
/** The marketplace's ids for currencies and payment methods: short, plain. */
const MARKET_ID_RE = /^[A-Za-z0-9_-]+$/;
/** The largest EIP-155 id a chain uses here: a safe integer. */
const MAX_CHAIN_ID = Number.MAX_SAFE_INTEGER;

@ApiSchema({
  description:
    'An order on the P2P marketplace. On `/v1/onramp/p2p` a purchase: the local money paid, how, the token bought on its chain and where it is delivered. On `/v1/offramp/p2p` a sale: the token sold on its chain, the account it is sent from, and the local money received and how.',
})
export class P2pOrderDto {
  @ApiProperty({
    example: 'ARS',
    description:
      'Local currency paid (purchase) or received (sale): an `id` from the market of the same route, `GET /v1/onramp/p2p/market` or `GET /v1/offramp/p2p/market`.',
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
      'How the local money is paid (purchase) or received (sale): one of that currency’s `paymentMethods` in the market.',
  })
  @IsString()
  @MaxLength(64)
  @Matches(MARKET_ID_RE, {
    message: 'paymentMethod must be a payment method id from the market',
  })
  paymentMethod!: string;

  @ApiProperty({
    example: 42161,
    description:
      'EIP-155 id of the chain the token is on: a `chainId` of the market’s `networks`.',
  })
  @Type(() => Number)
  @IsInt({ message: 'chainId must be an EIP-155 chain id from the market' })
  @Min(1)
  @Max(MAX_CHAIN_ID)
  chainId!: number;

  @ApiProperty({
    example: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    description:
      'The token bought or sold: its contract `address` on `chainId`, from `GET .../tokens?chainId=` of the same route (the zero address is the chain’s own coin).',
  })
  @IsString()
  @Matches(EVM_ADDRESS_RE, {
    message:
      'token must be a token contract address (0x and 40 hex digits; the zero address for the chain’s own coin)',
  })
  token!: string;

  @ApiProperty({
    example: '50000',
    description:
      'What the order puts in, a decimal string: the local money paid for a purchase (at most two decimals, at least the currency’s `minAmount`), the token sold for a sale (at most the token’s decimals, worth at least the currency’s `minAmount` in USD where the token has a USD price).',
  })
  @IsString()
  @Matches(AMOUNT_RE, {
    message: 'amount must be a decimal string',
  })
  amount!: string;

  @ApiProperty({
    example: '0x52908400098527886E0F7030069857D2E4169EE7',
    description:
      'An EVM account on `chainId`: where a purchase delivers the token, or the account a sale sends it from.',
  })
  @IsString()
  @Matches(EVM_ADDRESS_RE, {
    message: 'address must be an EVM address (0x and 40 hex digits)',
  })
  address!: string;
}

/** `GET .../tokens`: one chain's tokens, a page at a time, optionally searched. */
export class P2pTokensQueryDto extends PaginationQueryDto {
  @ApiProperty({
    example: 42161,
    description:
      'EIP-155 id of the chain: a `chainId` of the market’s `networks`.',
  })
  @Type(() => Number)
  @IsInt({ message: 'chainId must be an EIP-155 chain id from the market' })
  @Min(1)
  @Max(MAX_CHAIN_ID)
  chainId!: number;

  @ApiPropertyOptional({
    example: 'usd',
    description:
      'A symbol fragment (any case) or a token contract address (exact, any case).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  q?: string;

  @ApiPropertyOptional({
    default: P2P_TOKENS_DEFAULT_TAKE,
    maximum: P2P_TOKENS_MAX_TAKE,
    minimum: 1,
    description: `Page size: how many tokens to return (1 to ${P2P_TOKENS_MAX_TAKE}).`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(P2P_TOKENS_MAX_TAKE)
  take: number = P2P_TOKENS_DEFAULT_TAKE;
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
