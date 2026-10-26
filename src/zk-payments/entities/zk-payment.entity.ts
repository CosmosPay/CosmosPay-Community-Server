import { ApiProperty } from '@nestjs/swagger';
import { ZkPaymentStatus } from '@generated/prisma/client';
import { MerchantFeeEntity } from '@/common/merchant-fee/merchant-fee.entity';

const TOKEN = 'CBQU5SGVPPYI5MVBVV5GYTYNHENHBY7J44WYYVDPTZ5UNK6JDEY232QX';
const RECIPIENT = 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO';
const FEE_ACCOUNT = 'GDUYXOQZFVPDVIVBTJNUCGYQEC3XSI2LQOQ3SJWJJ6ZY4JLCJZZFGTNQ';

/** Cosmos Pay's confidential token on one network: what a wallet needs to use it. */
export class ZkTokenEntity {
  @ApiProperty({
    example: TOKEN,
    description: 'The confidential token contract (C...).',
  })
  contractId!: string;

  @ApiProperty({ example: 'XLM', description: 'What it wraps: native XLM.' })
  symbol!: string;

  @ApiProperty({ example: 7 })
  decimals!: number;

  @ApiProperty({
    example: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    description: "Native XLM's Stellar Asset Contract on this network.",
  })
  underlying!: string;

  @ApiProperty({
    example: 5387137,
    description:
      'The ledger the token was deployed at: where a wallet replays its ' +
      'confidential balance from.',
  })
  deployedAtLedger!: number;
}

/** `GET /v1/zk-payments/config`: the caller's network, as the dashboard sets up. */
export class ZkPaymentsConfigEntity {
  @ApiProperty({
    example: true,
    description:
      'Whether private payments run on this network. False until the operator ' +
      'deploys the token there (mainnet today); every other field but ' +
      '`network`, `networkPassphrase`, `auditorId` and `feeBps` is then null.',
  })
  enabled!: boolean;

  @ApiProperty({
    enum: ['public', 'testnet'],
    example: 'testnet',
    description: "The network the API key's environment selects.",
  })
  network!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://soroban-testnet.stellar.org',
    description: 'The Soroban RPC to build and submit transactions through.',
  })
  rpcUrl!: string | null;

  @ApiProperty({ example: 'Test SDF Network ; September 2015' })
  networkPassphrase!: string;

  @ApiProperty({ type: ZkTokenEntity, nullable: true })
  token!: ZkTokenEntity | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'CAN45PFA5CVUCU3JB77IE2JNWNTRCDWMRNG55U452L3N2IOCAGOLTUVQ',
    description:
      'The UltraHonk verifier registry the token checks proofs with.',
  })
  verifier!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'CDKWSGQER4KNDTMZS2W7V4E32KSL7BVM3LBY7EBTPWZZ3SFG5CDAOLF2',
    description: "The auditor registry holding Cosmos Pay's key.",
  })
  auditorRegistry!: string | null;

  @ApiProperty({
    example: 0,
    description: 'The auditor id every account on the token registers under.',
  })
  auditorId!: number;

  @ApiProperty({ example: 1, description: 'The commission: 1 bps = 0.01%.' })
  feeBps!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: FEE_ACCOUNT,
    description: "Cosmos Pay's account the commission is transferred to.",
  })
  feeAccount!: string | null;
}

/** A private payment as its owner reads it. */
export class ZkPaymentEntity {
  @ApiProperty({ example: 'cmh4x2k9a0001l70g8v5q3z2w' })
  id!: string;

  @ApiProperty({
    enum: ZkPaymentStatus,
    example: 'PENDING',
    description:
      'As it reads now: a PENDING payment past `expiresAt` reads EXPIRED. It ' +
      'can still settle: transfers that closed before `expiresAt` paid it.',
  })
  status!: ZkPaymentStatus;

  @ApiProperty({ enum: ['public', 'testnet'], example: 'testnet' })
  network!: string;

  @ApiProperty({
    example: TOKEN,
    description: 'The confidential token both transfers must be made on.',
  })
  tokenContract!: string;

  @ApiProperty({
    example: '25.5',
    description:
      'What the payer pays in total, in XLM: `netAmount + feeAmount`, plus ' +
      '`merchantFee.amount` when there is one.',
  })
  amount!: string;

  @ApiProperty({
    example: '25.49745',
    description:
      'What the merchant receives: `amount - feeAmount`, less ' +
      '`merchantFee.amount` when there is one.',
  })
  netAmount!: string;

  @ApiProperty({
    example: '0.00255',
    description:
      'The commission: `ceil(amount * feeBps / 10000)` in stroops, at least one.',
  })
  feeAmount!: string;

  @ApiProperty({ example: 1 })
  feeBps!: number;

  @ApiProperty({ example: RECIPIENT, description: 'The merchant (G...).' })
  recipient!: string;

  @ApiProperty({ example: FEE_ACCOUNT })
  feeAccount!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'The account both transfers came from, once settled.',
  })
  payer!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  paymentTxHash!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  feeTxHash!: string | null;

  @ApiProperty({
    type: MerchantFeeEntity,
    nullable: true,
    description:
      'The merchant fee the request named, paid by a third confidential ' +
      'transfer to its wallet; null without one.',
  })
  merchantFee!: MerchantFeeEntity | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: "The merchant fee's transaction, once settled.",
  })
  merchantFeeTxHash!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Order #24' })
  description!: string | null;

  @ApiProperty({ example: 'order-24' })
  idempotencyKey!: string;

  @ApiProperty({ example: '2026-10-25T15:00:00.000Z' })
  expiresAt!: Date;

  @ApiProperty({
    type: Date,
    nullable: true,
    example: null,
    description: 'When the later of the two transfers closed, once settled.',
  })
  settledAt!: Date | null;

  @ApiProperty({ example: '2026-10-25T14:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-10-25T14:00:00.000Z' })
  updatedAt!: Date;
}

export class ZkPaymentListEntity {
  @ApiProperty({ type: [ZkPaymentEntity] })
  data!: ZkPaymentEntity[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}

/**
 * A private payment as its payer's checkout reads it: what to pay, to whom, on which
 * contracts. Never the owner's data: no consumer, no idempotency key, no
 * transaction hashes.
 */
export class PublicZkPaymentEntity {
  @ApiProperty({ example: 'cmh4x2k9a0001l70g8v5q3z2w' })
  id!: string;

  @ApiProperty({ enum: ZkPaymentStatus, example: 'PENDING' })
  status!: ZkPaymentStatus;

  @ApiProperty({ example: '25.5' })
  amount!: string;

  @ApiProperty({ example: '25.49745' })
  netAmount!: string;

  @ApiProperty({ example: '0.00255' })
  feeAmount!: string;

  @ApiProperty({ example: 1 })
  feeBps!: number;

  @ApiProperty({
    example: RECIPIENT,
    description: 'Transfer `netAmount` here.',
  })
  recipient!: string;

  @ApiProperty({
    example: FEE_ACCOUNT,
    description: 'Transfer `feeAmount` here, from the same account.',
  })
  feeAccount!: string;

  @ApiProperty({
    type: MerchantFeeEntity,
    nullable: true,
    description:
      'When not null, a third transfer: `merchantFee.amount` to ' +
      '`merchantFee.wallet`, from the same account.',
  })
  merchantFee!: MerchantFeeEntity | null;

  @ApiProperty({ type: String, nullable: true, example: 'Order #24' })
  description!: string | null;

  @ApiProperty({ example: '2026-10-25T15:00:00.000Z' })
  expiresAt!: Date;

  @ApiProperty({ enum: ['public', 'testnet'], example: 'testnet' })
  network!: string;

  @ApiProperty({ example: 'https://soroban-testnet.stellar.org' })
  rpcUrl!: string;

  @ApiProperty({ example: 'Test SDF Network ; September 2015' })
  networkPassphrase!: string;

  @ApiProperty({ type: ZkTokenEntity })
  token!: ZkTokenEntity;

  @ApiProperty({
    example: 0,
    description:
      'The auditor id the transfers are encrypted to: Cosmos Pay reads the ' +
      'amount with it to confirm the payment.',
  })
  auditorId!: number;
}
