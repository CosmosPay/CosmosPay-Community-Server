import { ApiProperty, ApiSchema } from '@nestjs/swagger';

@ApiSchema({
  description: 'A stablecoin a P2P purchase can deliver on this network.',
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

@ApiSchema({ description: 'A way to pay local money in one currency.' })
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
  description: 'A local currency a buyer can pay with, and its buy price.',
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
      'Local money per stablecoin on the buy side, a decimal string. The firm price, fees included, is the quote.',
  })
  price!: string;

  @ApiProperty({
    example: '8389.45',
    description: 'Least local money one order takes, a decimal string.',
  })
  minAmount!: string;

  @ApiProperty({
    type: [P2pPaymentMethodEntity],
    description: 'How the buyer can pay in this currency.',
  })
  paymentMethods!: P2pPaymentMethodEntity[];
}

@ApiSchema({
  description: 'What can be bought with local money on the key’s network.',
})
export class P2pMarketEntity {
  @ApiProperty({
    example: 42161,
    description: 'EIP-155 id of the chain the stablecoin is delivered on.',
  })
  chainId!: number;

  @ApiProperty({
    example: 'arbitrum',
    description: '`arbitrum` on mainnet, `arbitrum-sepolia` in the sandbox.',
  })
  chain!: string;

  @ApiProperty({
    type: [P2pTokenEntity],
    description: 'The stablecoins a purchase can deliver.',
  })
  tokens!: P2pTokenEntity[];

  @ApiProperty({
    type: [P2pCurrencyEntity],
    description:
      'The currencies that can be bought right now: each with a price, a minimum and at least one payment method.',
  })
  currencies!: P2pCurrencyEntity[];
}

@ApiSchema({ description: 'The fees inside a P2P quote.' })
export class P2pQuoteFeeEntity {
  @ApiProperty({
    example: '0.90',
    description: 'Fees in the stablecoin bought, a decimal string.',
  })
  amountInToken!: string;

  @ApiProperty({
    example: '1329.06',
    description: 'Fees in the local currency paid, a decimal string.',
  })
  amountInFiat!: string;
}

@ApiSchema({
  description: 'A firm price for buying a stablecoin with local money.',
})
export class P2pQuoteEntity {
  @ApiProperty({
    example: '6f1c0e1a-1b2c-4d5e-8f90-123456789abc',
    description: 'The marketplace’s quote id.',
  })
  quoteId!: string;

  @ApiProperty({ example: 'ARS', description: 'Local currency paid.' })
  currency!: string;

  @ApiProperty({ example: 'USDC', description: 'Stablecoin bought.' })
  token!: string;

  @ApiProperty({
    example: 42161,
    description: 'EIP-155 id of the chain it is delivered on.',
  })
  chainId!: number;

  @ApiProperty({
    example: '54500',
    description: 'Local money paid, a decimal string.',
  })
  amountIn!: string;

  @ApiProperty({
    example: '35.04',
    description: 'Stablecoin delivered, fees taken, a decimal string.',
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
    'A purchase opened on the P2P marketplace: the order filled in and the widget URL that takes it, with the recipient fixed.',
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
    example: 'ARS',
    description: 'Local currency the buyer pays.',
  })
  currency!: string;

  @ApiProperty({ example: 'bank_tx_ar', description: 'How the buyer pays.' })
  paymentMethod!: string;

  @ApiProperty({
    example: '50000',
    description: 'Local money the buyer pays, a decimal string.',
  })
  amount!: string;

  @ApiProperty({ example: 'USDC', description: 'Stablecoin bought.' })
  token!: string;

  @ApiProperty({
    example: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    description: 'Its contract on `chainId` (EIP-55).',
  })
  tokenAddress!: string;

  @ApiProperty({
    example: 42161,
    description: 'EIP-155 id of the chain it is delivered on.',
  })
  chainId!: number;

  @ApiProperty({
    example: '0x52908400098527886E0F7030069857D2E4169EE7',
    description:
      'Where the stablecoin is delivered (EIP-55). The widget does not let the buyer change it.',
  })
  address!: string;

  @ApiProperty({
    example: '29.79',
    description:
      'About what `amount` buys at the market price when the session was opened, rounded down; the widget quotes the firm figure before payment.',
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
      'Open it in a browser tab or window (not an iframe): the buyer signs in, verifies their identity and pays a P2P seller there.',
  })
  widgetUrl!: string;

  @ApiProperty({
    example: '2026-11-05T18:00:00.000Z',
    description: 'When the session was opened.',
  })
  createdAt!: Date;
}

@ApiSchema({ description: 'A page of P2P purchase sessions, newest first.' })
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
