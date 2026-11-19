import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import {
  P2pMarketOrderEntity,
  P2pMarketPaymentDetailsEntity,
} from '@/p2p/entities/p2p-order.entity';

const CHARGE_ID = '9b7e2c41-3f5a-4d8e-a1b2-c3d4e5f60718';

@ApiSchema({
  description:
    'A charge in local money your customer pays on the hosted page: the tokens are delivered to `recipientAddress`, one of your registered wallets.',
})
export class P2pMarketChargeEntity {
  @ApiProperty({ example: CHARGE_ID })
  id!: string;

  @ApiProperty({ enum: ['public', 'testnet'], example: 'testnet' })
  tier!: string;

  @ApiProperty({ example: 'base' })
  network!: string;

  @ApiProperty({ example: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' })
  token!: string;

  @ApiProperty({ example: 'USDC' })
  tokenSymbol!: string;

  @ApiProperty({ example: 'ARS' })
  currency!: string;

  @ApiProperty({ example: '25000.00' })
  fiatAmount!: string;

  @ApiProperty({ example: 'cm3p2pacc0001l70g8v5q3z2w' })
  recipientAccountId!: string;

  @ApiProperty({ example: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' })
  recipientAddress!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Order #881' })
  description!: string | null;

  @ApiProperty({
    example: 'Tienda Salta',
    description: 'Who the payer sees it is paying.',
  })
  payeeName!: string;

  @ApiProperty({
    example: false,
    description:
      'Whether several payers may pay it; otherwise one order at a time, and it closes when paid.',
  })
  multiUse!: boolean;

  @ApiProperty({
    enum: ['open', 'paid', 'cancelled', 'expired'],
    example: 'open',
    description: '`expired` is read from `expiresAt`, never stored.',
  })
  status!: string;

  @ApiProperty({ example: 0, description: 'Orders that completed on it.' })
  paidCount!: number;

  @ApiProperty({ type: Date, nullable: true, example: null })
  paidAt!: Date | null;

  @ApiProperty({ example: '2026-11-20T12:00:00.000Z' })
  expiresAt!: Date;

  @ApiProperty({
    example: `https://pay.cosmospay.lat/p2p/${CHARGE_ID}`,
    description: 'The payer’s page. Share it, or show it as a QR.',
  })
  url!: string;

  @ApiProperty({
    example: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA',
    description: 'A QR of `url`, as a PNG data URL. Derived, never stored.',
  })
  qr!: string;

  @ApiProperty({ example: '2026-11-19T12:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-11-19T12:00:00.000Z' })
  updatedAt!: Date;
}

@ApiSchema({ description: 'A page of charges.' })
export class P2pMarketChargeListEntity {
  @ApiProperty({ type: [P2pMarketChargeEntity] })
  data!: P2pMarketChargeEntity[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}

/** `GET /v1/p2p-checkout/charges/{id}`. */
@ApiSchema({
  description:
    'A charge as its payer sees it: the amount, what it is for and the rails merchants take for it right now. Nothing about who created it.',
})
export class P2pCheckoutChargeEntity {
  @ApiProperty({ example: CHARGE_ID })
  id!: string;

  @ApiProperty({ example: 'base' })
  network!: string;

  @ApiProperty({ example: 'USDC' })
  tokenSymbol!: string;

  @ApiProperty({ example: 'ARS' })
  currency!: string;

  @ApiProperty({ example: '25000.00' })
  fiatAmount!: string;

  @ApiProperty({
    example: 'Tienda Salta',
    description:
      'Who the payer is paying: the name the charge’s creator chose (`payeeName`).',
  })
  merchantName!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Order #881' })
  description!: string | null;

  @ApiProperty({
    enum: ['open', 'paid', 'cancelled', 'expired'],
    example: 'open',
  })
  status!: string;

  @ApiProperty({
    type: [String],
    example: ['ar_bank_transfer'],
    description:
      'Rails a merchant offers for this currency, network and token now.',
  })
  rails!: string[];

  @ApiProperty({ example: '2026-11-20T12:00:00.000Z' })
  expiresAt!: Date;
}

/** An order of a charge as its payer reads it with the payer token. */
@ApiSchema({
  description:
    'A charge’s order as its payer sees it: how much to send, where, until when, and how it stands.',
})
export class P2pCheckoutOrderEntity {
  @ApiProperty({ example: '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10' })
  id!: string;

  @ApiProperty({ example: CHARGE_ID })
  chargeId!: string;

  @ApiProperty({
    enum: [
      'pending',
      'awaiting_payment',
      'paid',
      'disputed',
      'completed',
      'cancelled',
      'expired',
      'resolved',
      'failed',
    ],
    example: 'awaiting_payment',
  })
  status!: string;

  @ApiProperty({ example: 'ARS' })
  currency!: string;

  @ApiProperty({
    example: '25000.00',
    description: 'Exactly what to transfer.',
  })
  fiatAmount!: string;

  @ApiProperty({ example: 'ar_bank_transfer' })
  rail!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Pampa Cambio',
    description:
      'The merchant the payer transfers to (it fills the order), not the charge’s payee.',
  })
  merchantName!: string | null;

  @ApiProperty({
    type: Date,
    nullable: true,
    example: '2026-11-19T12:31:00.000Z',
  })
  paymentDeadline!: Date | null;

  @ApiProperty({
    type: P2pMarketPaymentDetailsEntity,
    nullable: true,
    description: 'Where to transfer, while the order is live.',
  })
  paymentDetails!: P2pMarketPaymentDetailsEntity | null;

  @ApiProperty({ type: Date, nullable: true, example: null })
  paidAt!: Date | null;

  @ApiProperty({
    type: Date,
    nullable: true,
    example: null,
    description:
      'When the settle window of a paid order closes: after it anyone may release the order, and the seller’s side can no longer dispute it. Null without a settle window, or before the order is paid.',
  })
  settleDeadline!: Date | null;

  @ApiProperty({ example: '2026-11-19T12:01:00.000Z' })
  createdAt!: Date;
}

/** `POST /v1/p2p-checkout/charges/{id}/orders`. */
@ApiSchema({
  description:
    'The payer’s new order, and the token that reads it and reports the payment. The token is shown once and never stored here (only its SHA-256): keep it in the page.',
})
export class P2pCheckoutCreatedOrderEntity extends P2pCheckoutOrderEntity {
  @ApiProperty({
    example: 'q3Jx8b2mNfV0tq9Lr5sD1uYc7wHk4eAa6zPgT0oXiEM',
    description: 'Send it as `X-Payer-Token` on the order’s routes.',
  })
  payerToken!: string;
}

@ApiSchema({ description: 'A payout item that never opened, and why.' })
export class P2pMarketFailedPayoutItemEntity {
  @ApiProperty({
    example: 1,
    description: 'Its position in the request, from 0.',
  })
  index!: number;

  @ApiProperty({ example: 'ARS' })
  currency!: string;

  @ApiProperty({ example: '50000' })
  fiatAmount!: string;

  @ApiProperty({ type: String, nullable: true, example: 'payroll-2026-11-ana' })
  externalReference!: string | null;

  @ApiProperty({ example: 'no merchant could take it' })
  reason!: string;
}

@ApiSchema({
  description:
    'A payout batch: one order per item a merchant took, and the items none could take.',
})
export class P2pMarketPayoutBatchEntity {
  @ApiProperty({ example: 'cm3p2ppob0001l70g8v5q3z2w' })
  id!: string;

  @ApiProperty({ enum: ['public', 'testnet'], example: 'testnet' })
  tier!: string;

  @ApiProperty({ example: 'base' })
  network!: string;

  @ApiProperty({ example: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' })
  token!: string;

  @ApiProperty({
    example: 'cm3p2pacc0001l70g8v5q3z2w',
    description: 'The account paying out.',
  })
  accountId!: string;

  @ApiProperty({
    enum: ['processing', 'completed', 'partially_completed', 'failed'],
    example: 'processing',
    description:
      'processing while any order is live; then completed (every order completed), partially_completed or failed (none did).',
  })
  status!: string;

  @ApiProperty({ example: 2 })
  itemCount!: number;

  @ApiProperty({
    type: [P2pMarketOrderEntity],
    description: 'Empty in a list; the batch read carries them.',
  })
  orders!: P2pMarketOrderEntity[];

  @ApiProperty({ type: [P2pMarketFailedPayoutItemEntity] })
  failedItems!: P2pMarketFailedPayoutItemEntity[];

  @ApiProperty({ type: Date, nullable: true, example: null })
  completedAt!: Date | null;

  @ApiProperty({ example: '2026-11-19T12:00:00.000Z' })
  createdAt!: Date;
}

@ApiSchema({ description: 'A page of payout batches (their orders left out).' })
export class P2pMarketPayoutBatchListEntity {
  @ApiProperty({ type: [P2pMarketPayoutBatchEntity] })
  data!: P2pMarketPayoutBatchEntity[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}
