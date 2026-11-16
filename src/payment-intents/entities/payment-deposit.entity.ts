import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { CrossChainSwapStatus } from '@generated/prisma/client';
import {
  CROSS_CHAIN_NETWORK_IDS,
  type CrossChainNetworkId,
} from '@/cross-chain-swaps/cross-chain-swaps.constants';
import {
  CrossChainFeeEntity,
  CrossChainTransactionEntity,
} from '@/cross-chain-swaps/entities/cross-chain-swap.entity';

/**
 * A deposit address made for one payer of one payment link: what the payer
 * sends, where, and how the payment stands. Answered to whoever holds the link
 * (`/v1/payment-links/{id}/deposits/...`) and to the link's owner
 * (`GET /v1/payment-intents/{id}/deposits`): written field by field from the
 * row by `toPaymentDepositEntity`, never spread, so the stored quote and the
 * observer's bookkeeping stay inside.
 */
@ApiSchema({
  description:
    'A deposit address made for one payment from any network: what the payer ' +
    'sends and where, and how the payment stands.',
})
export class PaymentDepositEntity {
  @ApiProperty({
    example: 'cm3dep0s1t0001l70g8v5q3z2w',
    description:
      "The deposit's id. With the link's id it is what reads the deposit back.",
  })
  id!: string;

  @ApiProperty({
    example: 'cmh4x2k9a0001l70g8v5q3z2w',
    description: 'The payment link (payment intent) this deposit pays.',
  })
  paymentLinkId!: string;

  @ApiProperty({
    enum: CrossChainSwapStatus,
    example: 'AWAITING_DEPOSIT',
    description:
      '`AWAITING_DEPOSIT`: nothing arrived yet. `DEPOSIT_DETECTED`, ' +
      '`PROCESSING`: the deposit is on its way. `INCOMPLETE_DEPOSIT`: less than ' +
      '`minAmountIn` arrived; send the rest before `expiresAt` or it is ' +
      'refunded. `SUCCEEDED`: the merchant was paid and the link is settled. ' +
      '`REFUNDED`, `FAILED`: the deposit went (or goes) back to `refundTo`, and ' +
      'the link can be paid again. `EXPIRED`: nothing arrived before ' +
      '`expiresAt` (a later deposit is refunded).',
  })
  status!: CrossChainSwapStatus;

  @ApiProperty({
    enum: CROSS_CHAIN_NETWORK_IDS,
    example: 'tron',
    description: 'The network the payer sends from.',
  })
  originChain!: CrossChainNetworkId;

  @ApiProperty({ example: 'USDT', description: "The sent asset's symbol." })
  originAsset!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    description:
      "The sent token's contract on its network; null for the native coin.",
  })
  originContract!: string | null;

  @ApiProperty({
    example: '25.284231',
    description:
      'What to send, in the origin asset: the fees and a small buffer for ' +
      'price moves are in it, and whatever is not needed is refunded to ' +
      '`refundTo` after the payment.',
  })
  amountIn!: string;

  @ApiProperty({
    example: '25.031458',
    description:
      'The least the deposit may be. Below it the deposit is refunded at ' +
      '`expiresAt` unless it is topped up.',
  })
  minAmountIn!: string;

  @ApiProperty({
    enum: CROSS_CHAIN_NETWORK_IDS,
    example: 'base',
    description: "The payment link's network: where the merchant is paid.",
  })
  destinationChain!: CrossChainNetworkId;

  @ApiProperty({
    example: 'USDC',
    description: "The payment link's asset: what the merchant receives.",
  })
  destinationAsset!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    description:
      "The payment link's token contract; null for the network's native coin.",
  })
  destinationContract!: string | null;

  @ApiProperty({
    example: '25',
    description:
      "Exactly the payment link's amount: what the merchant receives.",
  })
  amountOut!: string;

  @ApiProperty({
    example: 50,
    description:
      "Cosmos Pay's commission on a payment from another network, in basis " +
      'points of the deposit.',
  })
  feeBps!: number;

  @ApiProperty({
    example: '0.126421',
    description: 'That commission, in the origin asset (inside `amountIn`).',
  })
  feeAmount!: string;

  @ApiProperty({
    example: 'TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy',
    description: 'Where a refund goes, on the origin network.',
  })
  refundTo!: string;

  @ApiProperty({
    example: 'TXk4mWpuXSbT4F7wC6S5K3aA2CKUZPqT3a',
    description:
      'The address made for this payment, on the origin network: send ' +
      '`amountIn` of the origin asset here, and nothing else.',
  })
  depositAddress!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'A memo the deposit MUST carry (a Stellar deposit always has one); null ' +
      'when the address alone identifies the payment.',
  })
  depositMemo!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'The deposit as a wallet link on the origin network, where it has a ' +
      'wallet-link standard (SEP-7, Solana Pay, EIP-681, BIP-21 and its ' +
      'copies, TON transfer, CIP-13). Null: pay `depositAddress` (and ' +
      '`depositMemo`) with any wallet of that network.',
  })
  depositUri!: string | null;

  @ApiProperty({
    example: 'data:image/png;base64,iVBORw0KGgo…',
    description:
      'PNG data URL of a QR code: of `depositUri` when there is one, else of ' +
      '`depositAddress`.',
  })
  qr!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'What the merchant was paid, once the payment settled.',
  })
  amountOutPaid!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'What went back to `refundTo`, in the origin asset, once a refund is reported.',
  })
  refundedAmount!: string | null;

  @ApiProperty({
    type: [CrossChainTransactionEntity],
    nullable: true,
    description:
      'Transactions reported on the origin network; null until there are any.',
  })
  originTxHashes!: CrossChainTransactionEntity[] | null;

  @ApiProperty({
    type: [CrossChainTransactionEntity],
    nullable: true,
    description:
      "Transactions reported on the link's network (the payout to the " +
      'merchant); null until there are any.',
  })
  destinationTxHashes!: CrossChainTransactionEntity[] | null;

  @ApiProperty({
    example: 82,
    description:
      'The estimated time, in seconds after the deposit confirms, until the ' +
      'merchant is paid.',
  })
  timeEstimateSeconds!: number;

  @ApiProperty({
    example: '2026-11-16T15:45:53.576Z',
    description:
      'When the address stops accepting the deposit; one that arrives later is refunded.',
  })
  expiresAt!: string;

  @ApiProperty({ example: '2026-11-16T15:15:53.576Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-11-16T15:15:53.576Z' })
  updatedAt!: string;
}

@ApiSchema({
  description: "A payment intent's deposit addresses, newest first.",
})
export class PaymentDepositListEntity {
  @ApiProperty({ type: [PaymentDepositEntity] })
  data!: PaymentDepositEntity[];
}

/** What the payer sends, as a quote prices it. */
@ApiSchema({
  description:
    'The leg a payer sends, in a quote for paying a payment link from any network.',
})
export class PaymentDepositQuoteOrigin {
  @ApiProperty({ enum: CROSS_CHAIN_NETWORK_IDS, example: 'tron' })
  chain!: CrossChainNetworkId;

  @ApiProperty({ example: 'USDT', description: "The asset's symbol." })
  asset!: string;

  @ApiProperty({
    example: 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near',
    description: "The cross-chain route's id for the asset.",
  })
  assetId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    description:
      "The token's contract on its network; null for the native coin.",
  })
  contract!: string | null;

  @ApiProperty({
    example: '25.284231',
    description:
      'What to send: the fees and a small buffer for price moves are in it; ' +
      'what is not needed is refunded.',
  })
  amount!: string;

  @ApiProperty({
    example: '25.031458',
    description: 'The least a deposit may be before it is refunded.',
  })
  minimum!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '25.27',
    description: "The cross-chain route's USD valuation, informational only.",
  })
  amountUsd!: string | null;
}

/** What the merchant receives, as a quote prices it: always the link's amount. */
@ApiSchema({
  description:
    'The leg the merchant receives, in a quote for paying a payment link from ' +
    "any network: always the link's amount.",
})
export class PaymentDepositQuoteDestination {
  @ApiProperty({ enum: CROSS_CHAIN_NETWORK_IDS, example: 'base' })
  chain!: CrossChainNetworkId;

  @ApiProperty({ example: 'USDC', description: "The link's asset." })
  asset!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    description: "The link's token contract; null for the native coin.",
  })
  contract!: string | null;

  @ApiProperty({ example: '25', description: "The link's amount, exactly." })
  amount!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '24.99',
    description: "The cross-chain route's USD valuation, informational only.",
  })
  amountUsd!: string | null;
}

@ApiSchema({
  description:
    'Response of `POST /v1/payment-links/{id}/quote`: what paying the link ' +
    'from one network and asset costs. Nothing is stored.',
})
export class PaymentDepositQuoteEntity {
  @ApiProperty({ type: PaymentDepositQuoteOrigin })
  origin!: PaymentDepositQuoteOrigin;

  @ApiProperty({ type: PaymentDepositQuoteDestination })
  destination!: PaymentDepositQuoteDestination;

  @ApiProperty({
    type: CrossChainFeeEntity,
    description:
      "Cosmos Pay's commission on a payment from another network, in the " +
      'origin asset (inside `origin.amount`).',
  })
  fee!: CrossChainFeeEntity;

  @ApiProperty({
    example: 82,
    description:
      'The estimated time, in seconds after the deposit confirms, until the ' +
      'merchant is paid.',
  })
  timeEstimateSeconds!: number;
}

/** What paid an intent settled from another network. */
@ApiSchema({
  description:
    'What a payer sent when a payment from another network settled a payment intent.',
})
export class PaidFromEntity {
  @ApiProperty({
    example: 'cm3dep0s1t0001l70g8v5q3z2w',
    description: 'The deposit that settled the intent.',
  })
  depositId!: string;

  @ApiProperty({ enum: CROSS_CHAIN_NETWORK_IDS, example: 'tron' })
  chain!: CrossChainNetworkId;

  @ApiProperty({ example: 'USDT', description: "The sent asset's symbol." })
  asset!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    description: "The sent token's contract; null for the native coin.",
  })
  contract!: string | null;

  @ApiProperty({
    example: '25.284231',
    description:
      'What the deposit address was asked for, in the sent asset (any surplus ' +
      'was refunded to the payer).',
  })
  amount!: string;
}
