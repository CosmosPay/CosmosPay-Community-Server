import { ApiProperty, ApiSchema } from '@nestjs/swagger';

@ApiSchema({
  description: 'A stablecoin the P2P market trades on one network.',
})
export class P2pMarketTokenEntity {
  @ApiProperty({ example: 'USDC', description: 'Its symbol.' })
  symbol!: string;

  @ApiProperty({
    example: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    description: 'Its contract address (EIP-55): what requests name it by.',
  })
  address!: string;

  @ApiProperty({ example: 6, description: 'Decimal places of its base units.' })
  decimals!: number;
}

@ApiSchema({
  description:
    'One network the P2P market runs on for this API key: where the contract is, and what it trades.',
})
export class P2pMarketNetworkEntity {
  @ApiProperty({
    example: 'base',
    description: 'The network id requests use (`network`).',
  })
  id!: string;

  @ApiProperty({ example: 'Base', description: 'Its name, for a picker.' })
  name!: string;

  @ApiProperty({ example: 84532, description: 'Its EIP-155 chain id.' })
  chainId!: number;

  @ApiProperty({
    example: 'ETH',
    description: 'The chain’s own coin (gas), as wallets name it.',
  })
  nativeSymbol!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://sepolia.basescan.org',
    description:
      'An Etherscan-style explorer of this network: append `/tx/<hash>` or `/address/<address>`. Null where none was checked.',
  })
  explorerUrl!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://sepolia.base.org',
    description:
      'A PUBLIC node for `wallet_addEthereumChain`, from the public endpoints this service lists; never the node it reads through. Null where no public one is listed.',
  })
  rpcUrl!: string | null;

  @ApiProperty({
    example: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    description:
      "The P2P market contract: where balances are deposited and orders lock tokens. Verified against this service's build before it is listed.",
  })
  contract!: string;

  @ApiProperty({
    example: 50,
    description:
      'The protocol fee, basis points of every payment to a buyer, as the contract charges it now. Each order keeps the rate it was opened with.',
  })
  protocolFeeBps!: number;

  @ApiProperty({
    example: false,
    description:
      'Whether the contract is paused: no new deposits, orders or acceptances, while every withdrawal, release, cancellation and dispute still works.',
  })
  paused!: boolean;

  @ApiProperty({ type: [P2pMarketTokenEntity] })
  tokens!: P2pMarketTokenEntity[];
}

@ApiSchema({ description: 'One field of a payment rail’s account details.' })
export class P2pMarketRailFieldEntity {
  @ApiProperty({ example: 'cbu', description: 'The key in `details`.' })
  name!: string;

  @ApiProperty({
    example: 'CBU or CVU, 22 digits (or give alias instead)',
    description: 'What it holds, in English.',
  })
  description!: string;

  @ApiProperty({ example: false, description: 'Whether it must be given.' })
  required!: boolean;

  @ApiProperty({
    type: [String],
    required: false,
    example: ['savings', 'checking'],
    description: 'The values it takes, when it is a choice.',
  })
  options?: string[];
}

@ApiSchema({ description: 'A local payment rail and the details it needs.' })
export class P2pMarketRailEntity {
  @ApiProperty({
    example: 'ar_bank_transfer',
    description: 'The rail id requests use.',
  })
  id!: string;

  @ApiProperty({
    example: 'Bank transfer (CBU, CVU or alias)',
    description: 'Its name, in English.',
  })
  name!: string;

  @ApiProperty({ type: [P2pMarketRailFieldEntity] })
  fields!: P2pMarketRailFieldEntity[];
}

@ApiSchema({
  description: 'A local currency the market prices, with its rails.',
})
export class P2pMarketCurrencyEntity {
  @ApiProperty({ example: 'ARS', description: 'ISO 4217 code.' })
  code!: string;

  @ApiProperty({
    example: 2,
    description: 'Decimal places an amount in it may carry.',
  })
  decimals!: number;

  @ApiProperty({ type: [P2pMarketRailEntity] })
  rails!: P2pMarketRailEntity[];
}

@ApiSchema({ description: 'Seconds each step of an order may take, per kind.' })
export class P2pMarketWindowsEntity {
  @ApiProperty({
    example: 1800,
    description: 'A purchase or a charge: seconds to pay the merchant.',
  })
  buyPaymentWindow!: number;

  @ApiProperty({
    example: 300,
    description:
      'A sale or a payout: seconds the merchant has to accept it (locking its bond).',
  })
  sellAcceptWindow!: number;

  @ApiProperty({
    example: 1800,
    description: 'A sale or a payout: seconds the merchant then has to pay.',
  })
  sellPaymentWindow!: number;

  @ApiProperty({
    example: 21600,
    description:
      'A sale: seconds after the merchant marked it paid with no dispute before anyone may release it. A payout gets it only when the client enabled `autoSettle` for the matcher.',
  })
  sellSettleWindow!: number;
}

/** `GET /v1/p2p/market`. */
@ApiSchema({
  description:
    'The P2P market for this API key: the networks it runs on, their contracts and tokens, the currencies and rails, the fee, the windows and the matcher to authorise.',
})
export class P2pMarketOverviewEntity {
  @ApiProperty({
    enum: ['public', 'testnet'],
    example: 'testnet',
    description: "The tier the API key's environment selects (`prod`: public).",
  })
  tier!: string;

  @ApiProperty({
    example: true,
    description:
      'Whether the market runs on at least one network for this key.',
  })
  available!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    description:
      "Cosmos Pay's matcher: the address a seller authorises with `setMatcher` so purchases and payouts open on its balance. It can open orders within the cap the seller sets and act for a buyer it opened an order for; it can never withdraw or release a seller's tokens.",
  })
  matcher!: string | null;

  @ApiProperty({
    example: 1000,
    description:
      "The merchant's bond on a sale or a payout, basis points of the amount.",
  })
  bondBps!: number;

  @ApiProperty({
    example: 500,
    description: 'The most an integrator may charge per order, basis points.',
  })
  maxIntegratorFeeBps!: number;

  @ApiProperty({ type: P2pMarketWindowsEntity })
  windows!: P2pMarketWindowsEntity;

  @ApiProperty({ type: [P2pMarketNetworkEntity] })
  networks!: P2pMarketNetworkEntity[];

  @ApiProperty({ type: [P2pMarketCurrencyEntity] })
  currencies!: P2pMarketCurrencyEntity[];
}
