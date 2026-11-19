import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { P2pMarketTransactionEntity } from '@/p2p/entities/p2p-transaction.entity';

const STATUSES = [
  'pending',
  'awaiting_acceptance',
  'awaiting_payment',
  'paid',
  'disputed',
  'completed',
  'cancelled',
  'expired',
  'resolved',
  'failed',
];

@ApiSchema({ description: 'The transactions an order went through, by step.' })
export class P2pMarketOrderTxHashesEntity {
  @ApiProperty({
    type: String,
    nullable: true,
    example:
      '0x6b1f8c3e2d7a4b5c9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f',
  })
  open!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  accept!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  paid!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  release!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  cancel!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  dispute!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  resolve!: string | null;
}

@ApiSchema({ description: 'What an order paid out when it ended, base units.' })
export class P2pMarketOrderSettlementEntity {
  @ApiProperty({
    example: '99500000',
    description: 'To the buyer of the tokens, after fees.',
  })
  toBuyer!: string;

  @ApiProperty({ example: '0', description: 'Back to the seller.' })
  toSeller!: string;

  @ApiProperty({
    example: '0',
    description: 'Of the buyer’s bond, to the seller (a resolution only).',
  })
  bondToSeller!: string;

  @ApiProperty({ example: '500000' })
  protocolFee!: string;

  @ApiProperty({ example: '0' })
  integratorFee!: string;
}

@ApiSchema({
  description:
    "The merchant's account to pay, shown to the client of a live purchase or charge only.",
})
export class P2pMarketPaymentDetailsEntity {
  @ApiProperty({ example: 'ar_bank_transfer' })
  rail!: string;

  @ApiProperty({
    example: 'María Pérez',
    description: 'The holder the transfer goes to.',
  })
  holderName!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { alias: 'pampa.cambio', cuit: '20123456786' },
  })
  details!: Record<string, string>;
}

@ApiSchema({ description: 'The merchant of an order, as its client sees it.' })
export class P2pMarketOrderMerchantEntity {
  @ApiProperty({ type: String, nullable: true, example: 'Pampa Cambio' })
  displayName!: string | null;
}

/** An order as the client (the consumer that created it) reads it. */
@ApiSchema({
  description:
    'A P2P order as the API consumer that created it sees it. `status` moves only on what the chain shows: `pending` (the opening transaction is not indexed yet, or a sale waits for the seller’s signature), `awaiting_acceptance`, `awaiting_payment`, `paid`, `disputed`, then `completed`, `cancelled`, `expired` (cancelled after a deadline), `resolved` (by the arbiter) or `failed` (never opened).',
})
export class P2pMarketOrderEntity {
  @ApiProperty({ example: '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10' })
  id!: string;

  @ApiProperty({
    enum: ['BUY', 'SELL', 'CHARGE', 'PAYOUT'],
    example: 'BUY',
    description:
      'BUY: a person buys tokens from a merchant. SELL: a person sells tokens to a merchant. CHARGE: a payer pays one of your charges. PAYOUT: a merchant pays a beneficiary from your balance.',
  })
  kind!: string;

  @ApiProperty({ enum: STATUSES, example: 'awaiting_payment' })
  status!: string;

  @ApiProperty({ enum: ['public', 'testnet'], example: 'testnet' })
  tier!: string;

  @ApiProperty({ example: 'base' })
  network!: string;

  @ApiProperty({ example: 84532 })
  chainId!: number;

  @ApiProperty({ example: '0x5FbDB2315678afecb367f032d93F642f64180aa3' })
  contract!: string;

  @ApiProperty({ example: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' })
  token!: string;

  @ApiProperty({ example: 'USDC' })
  tokenSymbol!: string;

  @ApiProperty({ example: 6 })
  tokenDecimals!: number;

  @ApiProperty({ example: 'ARS' })
  currency!: string;

  @ApiProperty({ example: 'ar_bank_transfer' })
  rail!: string;

  @ApiProperty({ example: '1250.5' })
  price!: string;

  @ApiProperty({
    example: '125050.00',
    description: 'The local money that changes hands.',
  })
  fiatAmount!: string;

  @ApiProperty({
    example: '100000000',
    description: 'Base units the order locks.',
  })
  tokenAmount!: string;

  @ApiProperty({
    example: '99500000',
    description: 'Base units its buyer receives after fees.',
  })
  netAmount!: string;

  @ApiProperty({ example: 50 })
  protocolFeeBps!: number;

  @ApiProperty({ example: 0 })
  integratorFeeBps!: number;

  @ApiProperty({
    example: '0',
    description: 'The merchant’s bond, base units (sales and payouts).',
  })
  bond!: string;

  @ApiProperty({ example: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' })
  sellerAddress!: string;

  @ApiProperty({ example: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' })
  buyerAddress!: string;

  @ApiProperty({ type: P2pMarketOrderMerchantEntity })
  merchant!: P2pMarketOrderMerchantEntity;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '7',
    description: 'The order id in the contract, once indexed.',
  })
  onchainId!: string | null;

  @ApiProperty({ type: Date, nullable: true, example: null })
  acceptDeadline!: Date | null;

  @ApiProperty({
    type: Date,
    nullable: true,
    example: '2026-11-19T12:31:00.000Z',
  })
  paymentDeadline!: Date | null;

  @ApiProperty({ type: Date, nullable: true, example: null })
  paidAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true, example: null })
  endedAt!: Date | null;

  @ApiProperty({ type: P2pMarketOrderTxHashesEntity })
  txHashes!: P2pMarketOrderTxHashesEntity;

  @ApiProperty({ type: P2pMarketOrderSettlementEntity, nullable: true })
  settlement!: P2pMarketOrderSettlementEntity | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'TRX-88213',
    description: 'The transfer reference reported with the payment.',
  })
  paidReference!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Why a `failed` order never opened.',
  })
  failureReason!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  chargeId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  payoutBatchId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'order-881' })
  externalReference!: string | null;

  @ApiProperty({
    type: P2pMarketPaymentDetailsEntity,
    nullable: true,
    description:
      'Where the person pays the local money: the merchant’s account, on a purchase or a charge while it is live. Null otherwise.',
  })
  paymentDetails!: P2pMarketPaymentDetailsEntity | null;

  @ApiProperty({ example: '2026-11-19T12:01:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-11-19T12:01:00.000Z' })
  updatedAt!: Date;
}

/** `POST /v1/p2p/orders`: the order, and for a sale the transactions to sign. */
@ApiSchema({
  description:
    'A new order. A sale (`SELL`) also carries the two transactions the seller’s wallet signs, in order: the exact token approval, then `openWithDeposit`.',
})
export class P2pMarketCreatedOrderEntity extends P2pMarketOrderEntity {
  @ApiProperty({
    type: [P2pMarketTransactionEntity],
    description: 'Empty except on a sale.',
  })
  transactions!: P2pMarketTransactionEntity[];
}

@ApiSchema({ description: 'A page of orders.' })
export class P2pMarketOrderListEntity {
  @ApiProperty({ type: [P2pMarketOrderEntity] })
  data!: P2pMarketOrderEntity[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}

@ApiSchema({
  description:
    'Who says they paid: shown to the merchant of a live purchase or charge.',
})
export class P2pMarketPayerEntity {
  @ApiProperty({ example: 'Juan Gómez' })
  name!: string;

  @ApiProperty({ example: '20123456786' })
  document!: string;
}

@ApiSchema({
  description:
    'Where the merchant pays the local money on a sale or a payout, shown to that merchant while it is live.',
})
export class P2pMarketBeneficiaryEntity {
  @ApiProperty({ example: 'Ana López' })
  holderName!: string;

  @ApiProperty({ example: '27234567891' })
  document!: string;

  @ApiProperty({ example: 'ar_bank_transfer' })
  rail!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { cbu: '2850590940090418135201', cuit: '27234567891' },
  })
  details!: Record<string, string>;
}

/** An order as its merchant reads it. */
@ApiSchema({
  description:
    'A P2P order as its merchant sees it: the payer’s identity on a live purchase or charge (check the transfer comes from that person), the beneficiary’s account on a live sale or payout (where to pay). Nothing about the client that created it.',
})
export class P2pMarketMerchantOrderEntity {
  @ApiProperty({ example: '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10' })
  id!: string;

  @ApiProperty({ enum: ['BUY', 'SELL', 'CHARGE', 'PAYOUT'], example: 'BUY' })
  kind!: string;

  @ApiProperty({ enum: STATUSES, example: 'paid' })
  status!: string;

  @ApiProperty({ enum: ['public', 'testnet'], example: 'testnet' })
  tier!: string;

  @ApiProperty({ example: 'base' })
  network!: string;

  @ApiProperty({ example: 84532 })
  chainId!: number;

  @ApiProperty({ example: '0x5FbDB2315678afecb367f032d93F642f64180aa3' })
  contract!: string;

  @ApiProperty({
    example: 'cm3p2pacc0001l70g8v5q3z2w',
    type: String,
    nullable: true,
  })
  merchantAccountId!: string | null;

  @ApiProperty({
    enum: ['seller', 'buyer'],
    example: 'seller',
    description:
      'The merchant’s side: seller on purchases and charges (it releases), buyer on sales and payouts (it accepts and pays).',
  })
  merchantSide!: string;

  @ApiProperty({ example: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' })
  token!: string;

  @ApiProperty({ example: 'USDC' })
  tokenSymbol!: string;

  @ApiProperty({ example: 6 })
  tokenDecimals!: number;

  @ApiProperty({ example: 'ARS' })
  currency!: string;

  @ApiProperty({ example: 'ar_bank_transfer' })
  rail!: string;

  @ApiProperty({ example: '1250.5' })
  price!: string;

  @ApiProperty({ example: '125050.00' })
  fiatAmount!: string;

  @ApiProperty({ example: '100000000' })
  tokenAmount!: string;

  @ApiProperty({ example: '99500000' })
  netAmount!: string;

  @ApiProperty({ example: '0' })
  bond!: string;

  @ApiProperty({ example: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' })
  sellerAddress!: string;

  @ApiProperty({ example: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' })
  buyerAddress!: string;

  @ApiProperty({ type: String, nullable: true, example: '7' })
  onchainId!: string | null;

  @ApiProperty({ type: Date, nullable: true, example: null })
  acceptDeadline!: Date | null;

  @ApiProperty({
    type: Date,
    nullable: true,
    example: '2026-11-19T12:31:00.000Z',
  })
  paymentDeadline!: Date | null;

  @ApiProperty({
    type: Date,
    nullable: true,
    example: '2026-11-19T12:12:40.000Z',
  })
  paidAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true, example: null })
  endedAt!: Date | null;

  @ApiProperty({ type: P2pMarketOrderTxHashesEntity })
  txHashes!: P2pMarketOrderTxHashesEntity;

  @ApiProperty({ type: P2pMarketOrderSettlementEntity, nullable: true })
  settlement!: P2pMarketOrderSettlementEntity | null;

  @ApiProperty({ type: String, nullable: true, example: 'TRX-88213' })
  paidReference!: string | null;

  @ApiProperty({ type: P2pMarketPayerEntity, nullable: true })
  payer!: P2pMarketPayerEntity | null;

  @ApiProperty({ type: P2pMarketBeneficiaryEntity, nullable: true })
  beneficiary!: P2pMarketBeneficiaryEntity | null;

  @ApiProperty({ example: '2026-11-19T12:01:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-11-19T12:01:00.000Z' })
  updatedAt!: Date;
}

@ApiSchema({ description: 'A page of the merchant’s orders.' })
export class P2pMarketMerchantOrderListEntity {
  @ApiProperty({ type: [P2pMarketMerchantOrderEntity] })
  data!: P2pMarketMerchantOrderEntity[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}

@ApiSchema({
  description:
    'An order an incoming bank transfer most likely settles, with its release ready to sign.',
})
export class P2pMarketTransferMatchEntity {
  @ApiProperty({ type: P2pMarketMerchantOrderEntity })
  order!: P2pMarketMerchantOrderEntity;

  @ApiProperty({
    example: 3,
    description:
      '1 for the exact amount and currency, plus 1 for a matching payer name and 1 for a matching document.',
  })
  score!: number;

  @ApiProperty({ type: [String], example: ['amount', 'name', 'document'] })
  matchedOn!: string[];

  @ApiProperty({
    type: P2pMarketTransactionEntity,
    description:
      '`release` for the order, for the merchant’s wallet or its bot (PERM_RELEASE) to sign.',
  })
  transaction!: P2pMarketTransactionEntity;
}

@ApiSchema({ description: 'Orders a transfer may settle, best first.' })
export class P2pMarketTransferMatchListEntity {
  @ApiProperty({ type: [P2pMarketTransferMatchEntity] })
  data!: P2pMarketTransferMatchEntity[];
}
