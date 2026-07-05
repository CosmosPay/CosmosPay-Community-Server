import { ApiProperty } from '@nestjs/swagger';
import {
  LiquidityOperationKind,
  SwapStatus,
} from '../../../generated/prisma/client';

/** One side of a pool: an asset and how much of it the pool (or holder) has. */
export class LiquidityPoolReserve {
  @ApiProperty({ example: 'native', description: 'Asset code, or "native".' })
  asset!: string;

  @ApiProperty({ nullable: true, example: null })
  issuer!: string | null;

  @ApiProperty({ example: '82944.5873463' })
  amount!: string;
}

/** An on-chain liquidity pool (proxied from Horizon; nothing persisted). */
export class LiquidityPoolEntity {
  @ApiProperty({
    example: 'dd7b1ab831c273310ddbec6f97870aa83c2fbd78ce22aded37ecbf4f3380fac7',
  })
  id!: string;

  @ApiProperty({ example: 'testnet' })
  network!: string;

  @ApiProperty({ example: 30, description: 'Pool fee in basis points (0.3%).' })
  feeBp!: number;

  @ApiProperty({ example: '123', description: 'Accounts holding pool shares.' })
  totalTrustlines!: string;

  @ApiProperty({ example: '4462.7227546' })
  totalShares!: string;

  @ApiProperty({
    type: [LiquidityPoolReserve],
    description: 'Both reserves, canonical order.',
  })
  reserves!: LiquidityPoolReserve[];
}

export class LiquidityPoolListEntity {
  @ApiProperty({ type: [LiquidityPoolEntity] })
  data!: LiquidityPoolEntity[];

  @ApiProperty({
    nullable: true,
    example: '113725249324879873',
    description: 'Horizon paging cursor for the next page (null when done).',
  })
  cursor!: string | null;
}

/** An account's stake in one pool, with its proportionally redeemable amounts. */
export class LiquidityPositionEntity {
  @ApiProperty({
    example: 'dd7b1ab831c273310ddbec6f97870aa83c2fbd78ce22aded37ecbf4f3380fac7',
  })
  poolId!: string;

  @ApiProperty({ example: '50.25', description: 'Pool shares held.' })
  shares!: string;

  @ApiProperty({ example: '4462.7227546' })
  totalShares!: string;

  @ApiProperty({
    example: 112,
    description: 'Share of the pool in basis points (112 = 1.12%).',
  })
  shareOfPoolBps!: number;

  @ApiProperty({ type: [LiquidityPoolReserve] })
  reserves!: LiquidityPoolReserve[];

  @ApiProperty({
    type: [LiquidityPoolReserve],
    description:
      'What the shares redeem to at current reserves (pre-slippage).',
  })
  redeemable!: LiquidityPoolReserve[];
}

export class LiquidityPositionListEntity {
  @ApiProperty({
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  account!: string;

  @ApiProperty({ example: 'testnet' })
  network!: string;

  @ApiProperty({ type: [LiquidityPositionEntity] })
  data!: LiquidityPositionEntity[];
}

/** A persisted liquidity pool operation plus its derived QR. */
export class LiquidityOperationEntity {
  @ApiProperty({ example: 'clx9z8a1b0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ enum: LiquidityOperationKind, example: 'DEPOSIT' })
  kind!: LiquidityOperationKind;

  @ApiProperty({ enum: SwapStatus, example: 'PENDING' })
  status!: SwapStatus;

  @ApiProperty({ example: 'testnet' })
  network!: string;

  @ApiProperty({
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  source!: string;

  @ApiProperty({
    example: 'dd7b1ab831c273310ddbec6f97870aa83c2fbd78ce22aded37ecbf4f3380fac7',
  })
  poolId!: string;

  @ApiProperty({ example: 'native' })
  assetA!: string;

  @ApiProperty({ nullable: true, example: null })
  assetAIssuer!: string | null;

  @ApiProperty({ example: 'USDC' })
  assetB!: string;

  @ApiProperty({
    nullable: true,
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTR6F3DSZL5A3W4G4M4N4A5U4QY3T6',
  })
  assetBIssuer!: string | null;

  @ApiProperty({
    example: '1000',
    description:
      'DEPOSIT: maxAmountA cap. WITHDRAW: slippage-protected minimum of asset A.',
  })
  amountA!: string;

  @ApiProperty({
    example: '100',
    description:
      'DEPOSIT: maxAmountB cap. WITHDRAW: slippage-protected minimum of asset B.',
  })
  amountB!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'Pool shares burned (WITHDRAW only).',
  })
  shares!: string | null;

  @ApiProperty({
    nullable: true,
    example: '9.95',
    description: 'DEPOSIT only.',
  })
  minPrice!: string | null;

  @ApiProperty({
    nullable: true,
    example: '10.05',
    description: 'DEPOSIT only.',
  })
  maxPrice!: string | null;

  @ApiProperty({ example: 50 })
  slippageBps!: number;

  @ApiProperty({
    example: 50,
    description:
      'Plan commission in basis points (50 = 0.5%), applied to both assets.',
  })
  feeBps!: number;

  @ApiProperty({
    example: '5',
    description:
      'Commission taken from asset A (deducted from the deposit / the ' +
      'withdrawn minimum). "0" when no commission applies.',
  })
  feeAmountA!: string;

  @ApiProperty({
    example: '0.5',
    description: 'Commission taken from asset B. "0" when none.',
  })
  feeAmountB!: string;

  @ApiProperty({
    nullable: true,
    example: 'GBFEE...WALLET',
    description: 'Commission collector account (null when the fee is disabled).',
  })
  feeWallet!: string | null;

  @ApiProperty({
    nullable: true,
    example: 'Cosmos Liquidity Commission',
    description:
      'On-chain MEMO_TEXT label stamped when a commission is collected and no ' +
      'caller memo was supplied (null when no commission applies).',
  })
  commissionMemo!: string | null;

  @ApiProperty({
    description: 'Unsigned transaction envelope (base64 XDR) to sign.',
    example: 'AAAAAgAAAABx…(base64 XDR)…AAAAAAAAAAA=',
  })
  xdr!: string;

  @ApiProperty({ example: 'web+stellar:tx?xdr=AAAAAgAAAABx…' })
  uri!: string;

  @ApiProperty({
    description: 'Deterministic transaction hash (verified on submit).',
    example: '3389e9f0...64hex',
  })
  txHash!: string;

  @ApiProperty({ example: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA…' })
  qr!: string;

  @ApiProperty({ nullable: true, example: '2026-07-04T12:39:56.000Z' })
  expiresAt!: Date | null;

  @ApiProperty({ example: '2026-07-04T12:34:56.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-07-04T12:34:56.000Z' })
  updatedAt!: Date;
}

export class LiquidityOperationListEntity {
  @ApiProperty({ type: [LiquidityOperationEntity] })
  data!: LiquidityOperationEntity[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}

/** Result of `POST /v1/liquidity-pools/operations/:id/submit`. */
export class LiquiditySubmitResultEntity {
  @ApiProperty({ example: true })
  submitted!: boolean;

  @ApiProperty({ enum: SwapStatus, example: 'SUCCEEDED' })
  status!: SwapStatus;

  @ApiProperty({
    required: false,
    nullable: true,
    example: '3389e9f0...64hex',
    description: 'The on-chain transaction hash once submitted.',
  })
  txHash?: string;

  @ApiProperty({
    required: false,
    nullable: true,
    example: null,
    description: 'Why submission failed, when `submitted` is false.',
  })
  reason?: string;

  @ApiProperty({
    required: false,
    nullable: true,
    type: [String],
    example: ['op_bad_price'],
    description: 'Horizon transaction/operation result codes on a rejection.',
  })
  resultCodes?: string[];

  @ApiProperty({ type: LiquidityOperationEntity })
  operation!: LiquidityOperationEntity;
}
