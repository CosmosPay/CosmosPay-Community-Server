import { ApiProperty, ApiSchema } from '@nestjs/swagger';

@ApiSchema({
  description:
    'A stablecoin traded on this network: one a purchase delivers, or one a sale sends.',
})
export class P2pTokenEntity {
  @ApiProperty({
    example: 'USDC',
    description: 'Symbol, as orders name it in `token`.',
  })
  symbol!: string;

  @ApiProperty({
    example: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    description: 'The token contract on `chain` (EIP-55).',
  })
  address!: string;

  @ApiProperty({ example: 6, description: 'Decimals of the token contract.' })
  decimals!: number;
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
      'Local money per stablecoin on this side of the market (what a buyer pays, or what a seller receives), a decimal string. The firm price, fees included, is the quote.',
  })
  price!: string;

  @ApiProperty({
    example: '8389.45',
    description:
      'Least an order puts in, a decimal string: local money for a purchase, the stablecoin for a sale.',
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
    example: 42161,
    description: 'EIP-155 id of the chain the stablecoin moves on.',
  })
  chainId!: number;

  @ApiProperty({
    example: 'arbitrum',
    description: '`arbitrum` on mainnet, `arbitrum-sepolia` in the sandbox.',
  })
  chain!: string;

  @ApiProperty({
    type: [P2pTokenEntity],
    description:
      'The stablecoins traded: a purchase delivers one, a sale sends one.',
  })
  tokens!: P2pTokenEntity[];

  @ApiProperty({
    type: [P2pCurrencyEntity],
    description:
      'The currencies this side trades right now: each with a price, a minimum and at least one payment method.',
  })
  currencies!: P2pCurrencyEntity[];
}

@ApiSchema({ description: 'The fees inside a P2P quote.' })
export class P2pQuoteFeeEntity {
  @ApiProperty({
    example: '0.90',
    description: 'Fees in the stablecoin, a decimal string.',
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
    'A firm price for an order on the P2P marketplace: a purchase of a stablecoin with local money, or a sale of one for it.',
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

  @ApiProperty({ example: 'USDC', description: 'Stablecoin bought or sold.' })
  token!: string;

  @ApiProperty({
    example: 42161,
    description: 'EIP-155 id of the chain it moves on.',
  })
  chainId!: number;

  @ApiProperty({
    example: '54500',
    description:
      'What the order puts in, a decimal string: local money for a purchase, the stablecoin for a sale.',
  })
  amountIn!: string;

  @ApiProperty({
    example: '35.04',
    description:
      'What it gives, fees taken, a decimal string: the stablecoin a purchase delivers, the local money a sale pays.',
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
    description: 'Local money per stablecoin, a decimal string.',
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
      'What the order puts in, a decimal string: local money for a purchase, the stablecoin for a sale.',
  })
  amount!: string;

  @ApiProperty({ example: 'USDC', description: 'Stablecoin bought or sold.' })
  token!: string;

  @ApiProperty({
    example: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    description: 'Its contract on `chainId` (EIP-55).',
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
      'EIP-55. A purchase: where the stablecoin is delivered, fixed in the widget so the buyer cannot change it. A sale: the account the order named as the one it is sent from; the seller connects that wallet in the widget.',
  })
  address!: string;

  @ApiProperty({
    example: '29.79',
    description:
      'About what `amount` gives at the market price when the session was opened, rounded down: the stablecoin a purchase delivers, or the local money a sale pays. The widget quotes the firm figure before anything moves.',
  })
  estimatedAmountOut!: string;

  @ApiProperty({
    example: 'cp-clz9xp2p0001',
    description: 'The reference the marketplace’s order carries.',
  })
  reference!: string;

  @ApiProperty({
    example:
      'https://p2p-widget.example/exchange?operation=BUY&token=0xaf88d065e77c8cC2239327C5EDb3A432268e5831&chain=42161&currency=ARS&paymentMethod=bank_tx_ar&amount=50000&address=0x52908400098527886E0F7030069857D2E4169EE7&externalReferenceId=cp-clz9xp2p0001',
    description:
      'Open it in a browser tab or window (not an iframe): the person signs in and verifies their identity there, then pays a P2P seller (purchase) or connects their wallet, sends the stablecoin and is paid by a P2P buyer (sale).',
  })
  widgetUrl!: string;

  @ApiProperty({
    example: '2026-11-05T18:00:00.000Z',
    description: 'When the session was opened.',
  })
  createdAt!: Date;
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
