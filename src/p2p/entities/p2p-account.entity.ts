import { ApiProperty, ApiSchema } from '@nestjs/swagger';

const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

@ApiSchema({
  description:
    'A registration challenge: the exact text the wallet signs with `personal_sign` (EIP-191), once, before `expiresAt`.',
})
export class P2pMarketChallengeEntity {
  @ApiProperty({
    example:
      'Cosmos Pay P2P market\nRegister wallet: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8\nFor: cosmos_6f1d2a\nTier: testnet\nNonce: 9f2c4e1ab37d5c08e6a1b2c3d4e5f607\nExpires: 2026-11-19T12:10:00.000Z',
    description:
      'The message to sign, byte for byte. It names the address, this API consumer, the tier, a single-use nonce and the expiry, so it registers nothing else.',
  })
  message!: string;

  @ApiProperty({ example: '2026-11-19T12:10:00.000Z' })
  expiresAt!: Date;
}

@ApiSchema({ description: "A merchant's track record, as quotes show it." })
export class P2pMarketMerchantStatsEntity {
  @ApiProperty({ example: 42, description: 'Orders completed.' })
  completedOrders!: number;

  @ApiProperty({
    example: 1,
    description:
      'Orders it had to act on and did not (a sale it never accepted or paid, an order it cancelled).',
  })
  cancelledOrders!: number;

  @ApiProperty({
    example: 0.97,
    description:
      'completed / (completed + cancelled); 0.5 for a merchant with no history yet.',
  })
  completionRate!: number;

  @ApiProperty({
    example: 0,
    description: 'Disputes an arbiter resolved against it.',
  })
  disputesLost!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 95,
    description:
      'Median seconds from paid to released, over its recent orders.',
  })
  medianReleaseSeconds!: number | null;
}

@ApiSchema({
  description:
    'A wallet this API consumer proved it holds, on the key’s tier: what it trades, charges and pays out from.',
})
export class P2pMarketAccountEntity {
  @ApiProperty({ example: 'cm3p2pacc0001l70g8v5q3z2w' })
  id!: string;

  @ApiProperty({ enum: ['public', 'testnet'], example: 'testnet' })
  tier!: string;

  @ApiProperty({
    example: ADDRESS,
    description: 'The wallet, EIP-55. The same on every network.',
  })
  address!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Treasury wallet' })
  label!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Pampa Cambio',
    description:
      'The name people see on a quote when this account is the merchant. Required before it can publish an offer.',
  })
  displayName!: string | null;

  @ApiProperty({
    enum: ['ACTIVE', 'PAUSED', 'SUSPENDED'],
    example: 'ACTIVE',
    description:
      'Whether its offers are matched. You set ACTIVE or PAUSED; SUSPENDED is set by the platform and only the platform lifts it.',
  })
  merchantStatus!: string;

  @ApiProperty({ type: P2pMarketMerchantStatsEntity })
  stats!: P2pMarketMerchantStatsEntity;

  @ApiProperty({
    type: Date,
    nullable: true,
    example: '2026-11-19T11:58:02.000Z',
  })
  lastActiveAt!: Date | null;

  @ApiProperty({ example: '2026-11-19T12:01:00.000Z' })
  verifiedAt!: Date;

  @ApiProperty({ example: '2026-11-19T12:01:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-11-19T12:01:00.000Z' })
  updatedAt!: Date;
}

@ApiSchema({ description: 'A balance an account holds in the contract.' })
export class P2pMarketBalanceEntity {
  @ApiProperty({ example: 'USDC' })
  symbol!: string;

  @ApiProperty({ example: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' })
  token!: string;

  @ApiProperty({
    example: '250000000',
    description:
      'Free balance in base units: what new orders can lock and what can be withdrawn.',
  })
  amount!: string;

  @ApiProperty({ example: 6 })
  decimals!: number;
}

@ApiSchema({
  description: "What the account allows Cosmos Pay's matcher on one network.",
})
export class P2pMarketMatcherTermsEntity {
  @ApiProperty({
    example: '500000000',
    description:
      'The largest order the matcher may open on this balance, base units; 0 = not authorised.',
  })
  maxPerOrder!: string;

  @ApiProperty({
    example: false,
    description:
      'Whether its orders may carry a settle window (silence after a payment releases them).',
  })
  autoSettle!: boolean;
}

@ApiSchema({
  description: 'An account on one network, read live from the contract.',
})
export class P2pMarketAccountNetworkEntity {
  @ApiProperty({ example: 'base' })
  network!: string;

  @ApiProperty({ type: [P2pMarketBalanceEntity] })
  balances!: P2pMarketBalanceEntity[];

  @ApiProperty({ type: P2pMarketMatcherTermsEntity })
  matcher!: P2pMarketMatcherTermsEntity;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC': 6 },
    description:
      'Operators the market saw this account grant on this network, with their permission bits (1 open, 2 release, 4 trade, 8 withdraw). A grant of 0 is a revocation and is left out.',
  })
  operators!: Record<string, number>;
}

@ApiSchema({
  description:
    'An account with its live state on every network the market runs on for this key.',
})
export class P2pMarketAccountDetailEntity extends P2pMarketAccountEntity {
  @ApiProperty({
    type: [P2pMarketAccountNetworkEntity],
    description:
      'One entry per network; a network whose node cannot be read right now is left out.',
  })
  networks!: P2pMarketAccountNetworkEntity[];
}

@ApiSchema({ description: 'A page of accounts.' })
export class P2pMarketAccountListEntity {
  @ApiProperty({ type: [P2pMarketAccountEntity] })
  data!: P2pMarketAccountEntity[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}

@ApiSchema({
  description:
    'Where an account receives local money on one rail. Shown in full to its owner, and to the counterparty of a live order only.',
})
export class P2pMarketPaymentMethodEntity {
  @ApiProperty({ example: 'cm3p2ppm00001l70g8v5q3z2w' })
  id!: string;

  @ApiProperty({ example: 'cm3p2pacc0001l70g8v5q3z2w' })
  accountId!: string;

  @ApiProperty({ example: 'ARS' })
  currency!: string;

  @ApiProperty({ example: 'ar_bank_transfer' })
  rail!: string;

  @ApiProperty({
    example: 'María Pérez',
    description: 'The account holder, as the bank shows it.',
  })
  holderName!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { alias: 'pampa.cambio', cuit: '20123456786' },
    description:
      'The rail’s fields, normalized (`GET /v1/p2p/market` lists them per rail).',
  })
  details!: Record<string, string>;

  @ApiProperty({
    example: 'alias pampa.cambio',
    description: 'A short, masked line.',
  })
  summary!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Main account' })
  label!: string | null;

  @ApiProperty({
    example: true,
    description: 'Inactive methods are never shown on an order.',
  })
  active!: boolean;

  @ApiProperty({ example: '2026-11-19T12:01:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-11-19T12:01:00.000Z' })
  updatedAt!: Date;
}

@ApiSchema({ description: 'A page of payment methods.' })
export class P2pMarketPaymentMethodListEntity {
  @ApiProperty({ type: [P2pMarketPaymentMethodEntity] })
  data!: P2pMarketPaymentMethodEntity[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}
