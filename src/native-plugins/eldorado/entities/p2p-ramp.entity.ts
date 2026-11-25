import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { ApiPublicTokenProperty } from '@/common/decorators/api-record-token.decorator';

@ApiSchema({
  description:
    'The token a form starts from: the stablecoin the marketplace settles in, on its chain.',
})
export class P2pDefaultTokenEntity {
  @ApiProperty({
    example: 42161,
    description: 'EIP-155 id of its chain.',
  })
  chainId!: number;

  @ApiProperty({
    example: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    description:
      'Its contract on `chainId` (EIP-55), as orders name it in `token`.',
  })
  address!: string;

  @ApiProperty({ example: 'USDT0', description: 'Symbol.' })
  symbol!: string;

  @ApiProperty({ example: 6, description: 'Decimals of the token contract.' })
  decimals!: number;
}

@ApiSchema({
  description:
    'A token an order can name: one a purchase delivers, or one a sale sends, on its chain.',
})
export class P2pTokenEntity {
  @ApiProperty({
    example: 42161,
    description: 'EIP-155 id of its chain.',
  })
  chainId!: number;

  @ApiProperty({
    example: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    description:
      'Its contract on `chainId` (EIP-55), as orders name it in `token`. The zero address is the chain’s own coin.',
  })
  address!: string;

  @ApiProperty({
    example: 'USDT0',
    description: 'Symbol. Not unique on a chain: orders name the address.',
  })
  symbol!: string;

  @ApiProperty({ example: 6, description: 'Decimals of the token contract.' })
  decimals!: number;

  @ApiProperty({
    example: '0.9975',
    type: String,
    nullable: true,
    description:
      'USD per token, a decimal string: the marketplace’s price, or 1 for a USD stablecoin it has no price for; null otherwise. Estimates and a sale’s minimum need it.',
  })
  priceUsd!: string | null;

  @ApiProperty({
    example:
      'https://static.debank.com/image/arb_token/logo_url/0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9/logo.png',
    type: String,
    nullable: true,
    description:
      'Its logo as the P2P marketplace lists it, an https address, for a picker to show where you have no artwork of your own; null when it lists none (most tokens) or names CoinGecko or CoinMarketCap, whose images are not passed on. Not checked by this service: load it as any third-party image.',
  })
  logoUrl!: string | null;

  @ApiProperty({
    example: true,
    description:
      'Whether it is one of its network’s main assets, matched by address (they come first). A chain’s list reuses known symbols at other addresses (an "ARB" on BNB Chain that is not Arbitrum’s), so show a known token’s own artwork only when this is true.',
  })
  main!: boolean;
}

@ApiSchema({ description: 'A chain the market trades on.' })
export class P2pNetworkEntity {
  @ApiProperty({
    example: 42161,
    description: 'EIP-155 id, as orders name it in `chainId`.',
  })
  chainId!: number;

  @ApiProperty({ example: 'Arbitrum', description: 'Display name.' })
  name!: string;

  @ApiProperty({
    example: 2768,
    description:
      'How many tokens it lists: page through them with `GET .../tokens`.',
  })
  tokenCount!: number;
}

@ApiSchema({
  description: 'A way to pay or receive local money in one currency.',
})
export class P2pPaymentMethodEntity {
  @ApiProperty({
    example: 'bank_tx_ar',
    description: 'Id, as orders name it in `paymentMethod`.',
  })
  id!: string;

  @ApiProperty({ example: 'Bank Transfer (ARS)', description: 'Display name.' })
  name!: string;
}

@ApiSchema({
  description:
    'A local currency the market trades on one side, with its price and minimum there.',
})
export class P2pCurrencyEntity {
  @ApiProperty({
    example: 'ARS',
    description: 'Currency id, as orders name it in `currency`.',
  })
  id!: string;

  @ApiProperty({ example: 'Argentine Pesos', description: 'English name.' })
  name!: string;

  @ApiProperty({
    example: '1677.89',
    description:
      'Local money per USD stablecoin on this side of the market (what a buyer pays, or what a seller receives), a decimal string. Another token is valued through its `priceUsd`; the firm price, fees and the swap included, is the quote.',
  })
  price!: string;

  @ApiProperty({
    example: '8389.45',
    description:
      'Least an order puts in, a decimal string: local money for a purchase, USD worth of the token for a sale.',
  })
  minAmount!: string;

  @ApiProperty({
    type: [P2pPaymentMethodEntity],
    description: 'How the local money is paid (purchase) or received (sale).',
  })
  paymentMethods!: P2pPaymentMethodEntity[];
}

@ApiSchema({
  description:
    'One side of the P2P market on the key’s network: what can be bought with local money (on-ramp) or sold for it (off-ramp).',
})
export class P2pMarketEntity {
  @ApiProperty({
    type: [P2pCurrencyEntity],
    description:
      'The currencies this side trades right now: each with a price, a minimum and at least one payment method.',
  })
  currencies!: P2pCurrencyEntity[];

  @ApiProperty({
    type: [P2pNetworkEntity],
    description:
      'The chains an order can name, the default token’s first, then the longest token lists. A chain whose token list could not be read right now is left out.',
  })
  networks!: P2pNetworkEntity[];

  @ApiProperty({
    type: P2pDefaultTokenEntity,
    description: 'The token a form starts from.',
  })
  defaultToken!: P2pDefaultTokenEntity;
}

@ApiSchema({
  description: 'A page of one chain’s tokens, the most traded first.',
})
export class P2pTokenListEntity {
  @ApiProperty({
    type: [P2pTokenEntity],
    description: 'The tokens on this page.',
  })
  data!: P2pTokenEntity[];

  @ApiProperty({
    description: 'Matching tokens, not the page length.',
    example: 2768,
  })
  total!: number;

  @ApiProperty({
    example: 100,
    description:
      'The page size applied, from the `take` query parameter (default 100).',
  })
  take!: number;

  @ApiProperty({
    example: 0,
    description:
      'Tokens skipped before this page, from the `skip` query parameter (default 0).',
  })
  skip!: number;
}

@ApiSchema({ description: 'The fees inside a P2P quote.' })
export class P2pQuoteFeeEntity {
  @ApiProperty({
    example: '0.90',
    description: 'Fees in the token, a decimal string.',
  })
  amountInToken!: string;

  @ApiProperty({
    example: '1329.06',
    description: 'Fees in the local currency, a decimal string.',
  })
  amountInFiat!: string;
}

@ApiSchema({
  description:
    'A firm price for an order on the P2P marketplace: a purchase of a token with local money, or a sale of one for it.',
})
export class P2pQuoteEntity {
  @ApiProperty({
    example: '6f1c0e1a-1b2c-4d5e-8f90-123456789abc',
    description: 'The marketplace’s quote id.',
  })
  quoteId!: string;

  @ApiProperty({
    example: 'ARS',
    description: 'Local currency paid (purchase) or received (sale).',
  })
  currency!: string;

  @ApiProperty({
    example: 'USDT0',
    description: 'Symbol of the token bought or sold.',
  })
  token!: string;

  @ApiProperty({
    example: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    description: 'Its contract on `chainId` (EIP-55).',
  })
  tokenAddress!: string;

  @ApiProperty({
    example: 42161,
    description: 'EIP-155 id of the chain it moves on.',
  })
  chainId!: number;

  @ApiProperty({
    example: '54500',
    description:
      'What the order puts in, a decimal string: local money for a purchase, the token for a sale.',
  })
  amountIn!: string;

  @ApiProperty({
    example: '35.04',
    description:
      'What it gives, fees taken, a decimal string: the token a purchase delivers, the local money a sale pays.',
  })
  amountOut!: string;

  @ApiProperty({
    example: '34.343',
    description:
      'The least the order can deliver once it runs, a decimal string.',
  })
  minAmountOut!: string;

  @ApiProperty({
    example: '1516.5',
    description: 'Local money per token, a decimal string.',
  })
  exchangeRate!: string;

  @ApiProperty({
    type: P2pQuoteFeeEntity,
    description: 'The fees included in `amountOut`.',
  })
  fee!: P2pQuoteFeeEntity;

  @ApiProperty({
    example: '2026-11-05T18:05:00.000Z',
    description: 'When the quote stops being valid.',
  })
  expiresAt!: string;
}

@ApiSchema({
  description:
    'An order opened on the P2P marketplace (a purchase, or a sale): the order filled in and the widget URL that takes it.',
})
export class P2pSessionEntity {
  @ApiProperty({
    example: 'clz9xp2p0001',
    description: 'Cosmos Pay id of the session.',
  })
  id!: string;

  @ApiProperty({
    example: 'public',
    description: '`public` (mainnet) or `testnet` (the sandbox), from the key.',
  })
  network!: string;

  @ApiProperty({
    example: 'buy',
    enum: ['buy', 'sell'],
    description:
      '`buy` for a purchase (`/v1/onramp/p2p`), `sell` for a sale (`/v1/offramp/p2p`).',
  })
  side!: string;

  @ApiProperty({
    example: 'ARS',
    description: 'Local currency paid (purchase) or received (sale).',
  })
  currency!: string;

  @ApiProperty({
    example: 'bank_tx_ar',
    description: 'How the local money is paid (purchase) or received (sale).',
  })
  paymentMethod!: string;

  @ApiProperty({
    example: '50000',
    description:
      'What the order puts in, a decimal string: local money for a purchase, the token for a sale.',
  })
  amount!: string;

  @ApiProperty({
    example: 'USDT0',
    description: 'Symbol of the token bought or sold.',
  })
  token!: string;

  @ApiProperty({
    example: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    description:
      'Its contract on `chainId` (EIP-55); the zero address is the chain’s own coin.',
  })
  tokenAddress!: string;

  @ApiProperty({
    example: 42161,
    description: 'EIP-155 id of the chain it moves on.',
  })
  chainId!: number;

  @ApiProperty({
    example: '0x52908400098527886E0F7030069857D2E4169EE7',
    description:
      'EIP-55. A purchase: where the token is delivered, fixed in the widget so the buyer cannot change it. A sale: the account the order named as the one it is sent from; the seller connects that wallet in the widget.',
  })
  address!: string;

  @ApiProperty({
    example: '29.79',
    type: String,
    nullable: true,
    description:
      'About what `amount` gives at the market price when the session was opened, rounded down: the token a purchase delivers, or the local money a sale pays. Null for a token with no USD price. The widget quotes the firm figure before anything moves.',
  })
  estimatedAmountOut!: string | null;

  @ApiProperty({
    example: 'cp-clz9xp2p0001',
    description: 'The reference the marketplace’s order carries.',
  })
  reference!: string;

  @ApiProperty({
    example:
      'https://p2p-widget.example/exchange?operation=BUY&token=0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9&chain=42161&currency=ARS&paymentMethod=bank_tx_ar&amount=50000&address=0x52908400098527886E0F7030069857D2E4169EE7&externalReferenceId=cp-clz9xp2p0001',
    description:
      'Open it in a browser tab or window (not an iframe): the person signs in and verifies their identity there, then pays a P2P seller (purchase) or connects their wallet, sends the token and is paid by a P2P buyer (sale).',
  })
  widgetUrl!: string;

  @ApiProperty({
    example: null,
    type: String,
    nullable: true,
    description:
      'The marketplace’s last status for the order, as it reports it (`REQUESTED`, `ACCEPTED`, `FIAT_PAID`, `FIAT_RECEIVED`, `COMPLETED`, `CANCELLED`, `DISPUTED`, `WAITING_FOR_FUNDS`, ...); null until it reports one. A completed order stays `COMPLETED`.',
  })
  status!: string | null;

  @ApiProperty({
    example: null,
    type: String,
    nullable: true,
    description:
      'The payment request a payer opened this purchase from (`/v1/onramp/p2p/payment-requests`); null for every other session.',
  })
  paymentRequestId!: string | null;

  @ApiProperty({
    example: '2026-11-05T18:00:00.000Z',
    description: 'When the session was opened.',
  })
  createdAt!: Date;
}

/** What opening a session answers: the session, and its read token. */
@ApiSchema({
  description:
    'What opening a P2P session answers: the session and, for the shared ' +
    'public key, its read token.',
})
export class P2pSessionCreatedEntity extends P2pSessionEntity {
  @ApiPublicTokenProperty()
  publicToken?: string;
}

@ApiSchema({
  description: 'A page of P2P sessions of one side, newest first.',
})
export class P2pSessionListEntity {
  @ApiProperty({
    type: [P2pSessionEntity],
    description: 'The sessions on this page.',
  })
  data!: P2pSessionEntity[];

  @ApiProperty({
    description: 'Matching rows, not the page length.',
    example: 1,
  })
  total!: number;

  @ApiProperty({
    example: 100,
    description:
      'The page size applied, from the `take` query parameter (default 100).',
  })
  take!: number;

  @ApiProperty({
    example: 0,
    description:
      'Rows skipped before this page, from the `skip` query parameter (default 0).',
  })
  skip!: number;
}
