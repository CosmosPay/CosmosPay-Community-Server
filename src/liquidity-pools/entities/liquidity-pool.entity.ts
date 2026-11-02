import {
  ApiProperty,
  ApiPropertyOptional,
  ApiSchema,
  OmitType,
} from '@nestjs/swagger';
import { LiquidityOperationKind, SwapStatus } from '@generated/prisma/client';
import { MerchantFeeEntity } from '@/common/merchant-fee/merchant-fee.entity';

/** A liquidity operation's merchant fee: `amount` / `asset` are asset A's leg. */
@ApiSchema({
  description:
    'The merchant fee a liquidity operation charged: `bps` of each asset, with ' +
    '`amount` and `asset` for asset A and `amountB` and `assetB` for asset B.',
})
export class LiquidityMerchantFeeEntity extends MerchantFeeEntity {
  @ApiProperty({
    description: 'The fee charged on asset B, in asset B.',
    example: '0.05',
  })
  amountB!: string;

  @ApiProperty({
    description: 'Asset B (`native` for XLM).',
    example: 'USDC',
  })
  assetB!: string;
}

/** One side of a pool: an asset and how much of it the pool (or holder) has. */
@ApiSchema({
  description:
    'One side of a liquidity pool: an asset and how much of it the pool holds, ' +
    'or a holder can redeem.',
})
export class LiquidityPoolReserve {
  @ApiProperty({ example: 'native', description: 'Asset code, or "native".' })
  asset!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description: "The asset's issuer account; null for native XLM.",
  })
  issuer!: string | null;

  @ApiProperty({
    example: '82944.5873463',
    description:
      "Amount of the asset, as a decimal string in the asset's units (up to 7 decimal places).",
  })
  amount!: string;
}

/** An on-chain liquidity pool (proxied from Horizon; nothing persisted). */
@ApiSchema({
  description:
    "An on-chain Stellar liquidity pool, read from Horizon on the API key's " +
    'network. Nothing is persisted.',
})
export class LiquidityPoolEntity {
  @ApiProperty({
    example: 'dd7b1ab831c273310ddbec6f97870aa83c2fbd78ce22aded37ecbf4f3380fac7',
    description: 'Stellar liquidity pool id (64-character lowercase hex).',
  })
  id!: string;

  @ApiProperty({
    example: 'testnet',
    description:
      'The Stellar network the pool was read from, which follows the API key: `public` (mainnet) or `testnet`.',
  })
  network!: string;

  @ApiProperty({ example: 30, description: 'Pool fee in basis points (0.3%).' })
  feeBp!: number;

  @ApiProperty({ example: '123', description: 'Accounts holding pool shares.' })
  totalTrustlines!: string;

  @ApiProperty({
    example: '4462.7227546',
    description:
      'Total pool shares outstanding, as a decimal string (up to 7 decimal places).',
  })
  totalShares!: string;

  @ApiProperty({
    type: [LiquidityPoolReserve],
    description: 'Both reserves, canonical order.',
  })
  reserves!: LiquidityPoolReserve[];
}

@ApiSchema({
  description:
    'A page of on-chain liquidity pools from Horizon, with the cursor for the next page.',
})
export class LiquidityPoolListEntity {
  @ApiProperty({
    type: [LiquidityPoolEntity],
    description: "The pools on this page, in Horizon's descending order.",
  })
  data!: LiquidityPoolEntity[];

  @ApiProperty({
    nullable: true,
    example: '113725249324879873',
    description: 'Horizon paging cursor for the next page (null when done).',
  })
  cursor!: string | null;
}

/** An account's stake in one pool, with its proportionally redeemable amounts. */
@ApiSchema({
  description:
    "An account's stake in one liquidity pool, with what its shares redeem " +
    'at the current reserves.',
})
export class LiquidityPositionEntity {
  @ApiProperty({
    example: 'dd7b1ab831c273310ddbec6f97870aa83c2fbd78ce22aded37ecbf4f3380fac7',
    description: 'Stellar liquidity pool id (64-character lowercase hex).',
  })
  poolId!: string;

  @ApiProperty({ example: '50.25', description: 'Pool shares held.' })
  shares!: string;

  @ApiProperty({
    example: '4462.7227546',
    description:
      'Total pool shares outstanding, as a decimal string (up to 7 decimal places).',
  })
  totalShares!: string;

  @ApiProperty({
    example: 112,
    description: 'Share of the pool in basis points (112 = 1.12%).',
  })
  shareOfPoolBps!: number;

  @ApiProperty({
    type: [LiquidityPoolReserve],
    description: "The pool's two reserves, in canonical order.",
  })
  reserves!: LiquidityPoolReserve[];

  @ApiProperty({
    type: [LiquidityPoolReserve],
    description:
      'What the shares redeem to at current reserves (pre-slippage).',
  })
  redeemable!: LiquidityPoolReserve[];
}

@ApiSchema({
  description:
    "An account's liquidity pool share positions, read from Horizon on the API " +
    "key's network. Nothing is persisted.",
})
export class LiquidityPositionListEntity {
  @ApiProperty({
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    description: 'The Stellar account whose positions are listed.',
  })
  account!: string;

  @ApiProperty({
    example: 'testnet',
    description:
      'The Stellar network read, which follows the API key: `public` (mainnet) or `testnet`.',
  })
  network!: string;

  @ApiProperty({
    type: [LiquidityPositionEntity],
    description: 'One position per pool the account holds shares in.',
  })
  data!: LiquidityPositionEntity[];
}

/** A persisted liquidity pool operation plus its derived QR. */
@ApiSchema({
  description:
    'A liquidity pool deposit or withdrawal built by this service: the stored ' +
    'operation with its unsigned transaction, SEP-7 link and QR.',
})
export class LiquidityOperationEntity {
  @ApiProperty({
    example: 'clx9z8a1b0000abcd1234efgh',
    description: "The operation's id, used by the read and submit routes.",
  })
  id!: string;

  @ApiProperty({
    enum: LiquidityOperationKind,
    example: 'DEPOSIT',
    description:
      '`DEPOSIT` adds both assets to the pool; `WITHDRAW` burns pool shares for both reserves.',
  })
  kind!: LiquidityOperationKind;

  @ApiProperty({
    enum: SwapStatus,
    example: 'PENDING',
    description:
      'PENDING (built, unsigned), SUBMITTED (a signed transaction was sent to ' +
      'the network), SUCCEEDED (confirmed on the ledger), FAILED (rejected on ' +
      'the network) or EXPIRED (time bounds elapsed before submission).',
  })
  status!: SwapStatus;

  @ApiProperty({
    example: 'testnet',
    description:
      'The Stellar network the operation targets, which follows the API key: `public` (mainnet) or `testnet`.',
  })
  network!: string;

  @ApiProperty({
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    description:
      'The Stellar account that funds and signs the operation: the transaction source.',
  })
  source!: string;

  @ApiProperty({
    example: 'dd7b1ab831c273310ddbec6f97870aa83c2fbd78ce22aded37ecbf4f3380fac7',
    description: 'Stellar liquidity pool id (64-character lowercase hex).',
  })
  poolId!: string;

  @ApiProperty({
    example: 'native',
    description:
      "Asset A's code (`native` for XLM). The pair is stored in the protocol's canonical order (A < B).",
  })
  assetA!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description: "Asset A's issuer account; null for native XLM.",
  })
  assetAIssuer!: string | null;

  @ApiProperty({
    example: 'USDC',
    description: "Asset B's code (`native` for XLM).",
  })
  assetB!: string;

  @ApiProperty({
    nullable: true,
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTR6F3DSZL5A3W4G4M4N4A5U4QY3T6',
    description: "Asset B's issuer account; null for native XLM.",
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
    description:
      "A DEPOSIT's lower price bound (its `liquidityPoolDeposit` minPrice), in " +
      'asset A per unit of asset B, as a decimal string of up to 7 places: the ' +
      'pool price when the operation was built (reserve A / reserve B, or ' +
      '`amountA` / `amountB` for a pool with no reserves yet) less ' +
      '`slippageBps`, rounded down. The deposit fails on-chain at a price ' +
      'below it. Null on a WITHDRAW.',
  })
  minPrice!: string | null;

  @ApiProperty({
    nullable: true,
    example: '10.05',
    description:
      "A DEPOSIT's upper price bound (its `liquidityPoolDeposit` maxPrice), in " +
      'the same units as `minPrice`: the same pool price plus `slippageBps`, ' +
      'rounded up. The deposit fails on-chain at a price above it. Null on a ' +
      'WITHDRAW.',
  })
  maxPrice!: string | null;

  @ApiProperty({
    example: 50,
    description:
      'The slippage tolerance the operation was built with, in basis points (50 = 0.5%).',
  })
  slippageBps!: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '4242',
    description:
      "The caller's MEMO_ID (uint64 as a string), null when none was supplied. " +
      'A commission MEMO_TEXT is reported in `commissionMemo`, never here. ' +
      'Operations created before this field existed report null even when ' +
      'their envelope carries a MEMO_ID; the `xdr` is authoritative for those.',
  })
  memo?: string | null;

  @ApiProperty({
    nullable: true,
    required: false,
    example: 'lp-deposit-2026-08-23-001',
    description:
      'Client idempotency key when supplied via Idempotency-Key / body (null otherwise).',
  })
  idempotencyKey?: string | null;

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
    description:
      'Commission collector account (null when the fee is disabled).',
  })
  feeWallet!: string | null;

  @ApiProperty({
    type: LiquidityMerchantFeeEntity,
    nullable: true,
    description:
      'The merchant fee the request named: `bps` of each asset, `amount` in ' +
      'asset A and `amountB` in asset B, paid to `wallet` in this ' +
      'transaction; null without one.',
  })
  merchantFee!: LiquidityMerchantFeeEntity | null;

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

  @ApiProperty({
    example: 'web+stellar:tx?xdr=AAAAAgAAAABx…',
    description: 'A SEP-7 `tx` URI carrying `xdr`, for a wallet to sign.',
  })
  uri!: string;

  @ApiProperty({
    description: 'Deterministic transaction hash (verified on submit).',
    example: '3389e9f0...64hex',
  })
  txHash!: string;

  @ApiProperty({
    example: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA…',
    description: 'A QR code of `uri`, as a PNG data URL.',
  })
  qr!: string;

  @ApiProperty({
    nullable: true,
    example: '2026-07-04T12:39:56.000Z',
    description:
      "When the transaction's validity window closes (ISO 8601 date-time); after it the transaction can no longer settle.",
  })
  expiresAt!: Date | null;

  @ApiProperty({
    example: '2026-07-04T12:34:56.000Z',
    description: 'When the operation was built (ISO 8601 date-time).',
  })
  createdAt!: Date;

  @ApiProperty({
    example: '2026-07-04T12:34:56.000Z',
    description: 'When the operation was last updated (ISO 8601 date-time).',
  })
  updatedAt!: Date;
}

/**
 * An operation as `GET /v1/liquidity-pools/operations` lists it: the stored row.
 * The QR and the commission label are derived by the single read, not rendered
 * for every row of a page — fetch the operation for them. Declaring list items
 * as {@link LiquidityOperationEntity} made generated clients type two fields the
 * list never sent.
 */
@ApiSchema({
  description:
    'A liquidity pool operation as the list returns it: every field but `qr` ' +
    'and `commissionMemo`, which only the single read derives.',
})
export class LiquidityOperationListItemEntity extends OmitType(
  LiquidityOperationEntity,
  ['qr', 'commissionMemo'] as const,
) {}

@ApiSchema({
  description:
    "A page of the consumer's liquidity pool operations on the API key's network, newest first.",
})
export class LiquidityOperationListEntity {
  @ApiProperty({
    type: [LiquidityOperationListItemEntity],
    description: 'The operations on this page, newest first.',
  })
  data!: LiquidityOperationListItemEntity[];

  @ApiProperty({
    example: 1,
    description: 'How many operations match the filters, across all pages.',
  })
  total!: number;

  @ApiProperty({ example: 20, description: 'The page size applied.' })
  take!: number;

  @ApiProperty({
    example: 0,
    description: 'How many matching operations were skipped before this page.',
  })
  skip!: number;
}

/** Result of `POST /v1/liquidity-pools/operations/:id/submit`. */
@ApiSchema({
  description:
    'The result of relaying a signed liquidity pool transaction, with the ' +
    'operation as it stands afterwards.',
})
export class LiquiditySubmitResultEntity {
  @ApiProperty({
    example: true,
    description:
      'True when the transaction was confirmed on the ledger (status ' +
      'SUCCEEDED); false when this broadcast was rejected (see `reason`).',
  })
  submitted!: boolean;

  @ApiProperty({
    enum: SwapStatus,
    example: 'SUCCEEDED',
    description: "The operation's status after this submission.",
  })
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
    description:
      'Why submission failed, when `submitted` is false. With `status` ' +
      'FAILED the ledger confirms the failure; with `status` SUBMITTED the ' +
      'network refused this broadcast but the transaction may still be on ' +
      'the ledger, and its outcome arrives as a terminal webhook.',
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

  @ApiProperty({
    type: LiquidityOperationEntity,
    description: 'The operation after this submission.',
  })
  operation!: LiquidityOperationEntity;
}
