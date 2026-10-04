import { ApiProperty, OmitType } from '@nestjs/swagger';
import { SwapStatus } from '@generated/prisma/client';

/** One asset hop on the chosen path (empty array = direct order-book swap). */
export class SwapPathHop {
  @ApiProperty({ example: 'yXLM', description: 'Asset code, or "native".' })
  code!: string;

  @ApiProperty({
    nullable: true,
    example: 'GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55',
    description: 'Issuer for a non-native hop (null for native).',
  })
  issuer!: string | null;
}

/** An asset + amount pair used on both sides of a quote. */
export class SwapAssetAmount {
  @ApiProperty({ example: 'native', description: 'Asset code, or "native".' })
  asset!: string;

  @ApiProperty({ nullable: true, example: null })
  issuer!: string | null;

  @ApiProperty({ example: '100' })
  amount!: string;
}

/** The platform fee taken from the source asset. */
export class SwapFeeBreakdown {
  @ApiProperty({ example: 'native' })
  asset!: string;

  @ApiProperty({ nullable: true, example: null })
  issuer!: string | null;

  @ApiProperty({ example: '0.5' })
  amount!: string;

  @ApiProperty({ example: 50, description: 'Fee in basis points (50 = 0.5%).' })
  bps!: number;

  @ApiProperty({
    nullable: true,
    example: 'GBFEE...WALLET',
    description: 'Fee collector account (null when the fee is disabled).',
  })
  wallet!: string | null;

  @ApiProperty({
    example: 'Cosmos Swap Commission',
    description:
      'Human-readable commission label, mirrored as the on-chain MEMO_TEXT ' +
      'when the caller supplies no memo.',
  })
  label!: string;
}

/** The bought asset with its estimate and slippage-protected minimum. */
export class SwapDestinationQuote {
  @ApiProperty({ example: 'USDC' })
  asset!: string;

  @ApiProperty({
    nullable: true,
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTR6F3DSZL5A3W4G4M4N4A5U4QY3T6',
  })
  issuer!: string | null;

  @ApiProperty({
    example: '24.81',
    description: 'Quoted amount received for the routed (post-fee) input.',
  })
  estimated!: string;

  @ApiProperty({
    example: '24.68595',
    description:
      'On-chain minimum (destMin) after slippage — swap reverts below it.',
  })
  minimum!: string;

  @ApiProperty({ example: 50 })
  slippageBps!: number;
}

/** Response of `POST /v1/swaps/quote` — pricing only, nothing is persisted. */
export class SwapQuoteEntity {
  @ApiProperty({ example: 'testnet' })
  network!: string;

  @ApiProperty({
    required: false,
    enum: ['solana', 'monad'],
    example: 'solana',
    description:
      'Solana and Monad quotes only. Absent on Stellar, which answers as it always has.',
  })
  chain?: string;

  @ApiProperty({
    required: false,
    enum: ['jupiter', 'kuru'],
    example: 'jupiter',
    description: 'The aggregator that priced a Solana or Monad swap.',
  })
  provider?: string;

  @ApiProperty({ type: SwapAssetAmount, description: 'Gross source input.' })
  source!: SwapAssetAmount;

  @ApiProperty({ type: SwapFeeBreakdown })
  fee!: SwapFeeBreakdown;

  @ApiProperty({
    type: SwapAssetAmount,
    description: 'Net amount routed (input − fee).',
  })
  swap!: SwapAssetAmount;

  @ApiProperty({ type: SwapDestinationQuote })
  destination!: SwapDestinationQuote;

  @ApiProperty({
    type: [SwapPathHop],
    description: 'Intermediate hops (may be empty).',
  })
  path!: SwapPathHop[];
}

/** A persisted swap (the `swap` table row) plus its derived QR. */
export class SwapEntity {
  @ApiProperty({ example: 'clx9z8a1b0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ enum: SwapStatus, example: 'PENDING' })
  status!: SwapStatus;

  @ApiProperty({ example: 'testnet' })
  network!: string;

  @ApiProperty({
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  source!: string;

  @ApiProperty({
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  destination!: string;

  @ApiProperty({ example: 'native' })
  sendAsset!: string;

  @ApiProperty({ nullable: true, example: null })
  sendAssetIssuer!: string | null;

  @ApiProperty({ example: '100', description: 'Gross source amount.' })
  sendAmount!: string;

  @ApiProperty({ example: '0.5' })
  feeAmount!: string;

  @ApiProperty({ example: 50 })
  feeBps!: number;

  @ApiProperty({
    example: '99.5',
    description: 'Amount routed through the DEX/AMM.',
  })
  swapAmount!: string;

  @ApiProperty({ example: 'USDC' })
  destAsset!: string;

  @ApiProperty({
    nullable: true,
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTR6F3DSZL5A3W4G4M4N4A5U4QY3T6',
  })
  destAssetIssuer!: string | null;

  @ApiProperty({ example: '24.81' })
  destEstimated!: string;

  @ApiProperty({ example: '24.68595' })
  destMin!: string;

  @ApiProperty({ example: 50 })
  slippageBps!: number;

  @ApiProperty({ type: [SwapPathHop] })
  path!: SwapPathHop[];

  @ApiProperty({ nullable: true, example: null })
  memo!: string | null;

  @ApiProperty({
    nullable: true,
    required: false,
    example: 'swap-retry-2026-08-23-001',
    description:
      'Client idempotency key when supplied via Idempotency-Key / body (null otherwise).',
  })
  idempotencyKey?: string | null;

  @ApiProperty({
    nullable: true,
    example: 'Cosmos Swap Commission',
    description:
      'On-chain MEMO_TEXT label stamped when a commission is collected and no ' +
      'caller memo was supplied (null otherwise).',
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

  @ApiProperty({
    nullable: true,
    description:
      "When the envelope's time bounds close; submit refuses it afterwards.",
    example: '2026-06-29T12:39:56.000Z',
  })
  expiresAt!: Date | null;

  @ApiProperty({ example: '2026-06-29T12:34:56.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-06-29T12:34:56.000Z' })
  updatedAt!: Date;
}

/**
 * A swap as `GET /v1/swaps` lists it: the stored row. The QR and the commission
 * label are derived by the single read, not rendered for every row of a page —
 * fetch the swap for them. Declaring list items as {@link SwapEntity} made
 * generated clients type two fields the list never sent.
 */
export class SwapListItemEntity extends OmitType(SwapEntity, [
  'qr',
  'commissionMemo',
] as const) {}

export class SwapListEntity {
  @ApiProperty({ type: [SwapListItemEntity] })
  data!: SwapListItemEntity[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}

/** Result of `POST /v1/swaps/:id/submit`. */
export class SwapSubmitResultEntity {
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
    example: ['op_under_dest_min'],
    description: 'Horizon transaction/operation result codes on a rejection.',
  })
  resultCodes?: string[];

  @ApiProperty({ type: SwapEntity })
  swap!: SwapEntity;
}

/**
 * A Solana or Monad swap (`chain_swap`): built by Jupiter or Kuru Flow, signed
 * by the wallet, relayed by this service. Returned by `/v1/swaps` when the
 * request names `chain: solana | monad`.
 */
export class ChainSwapEntity {
  @ApiProperty({ example: 'cm1x2y3z4a5b6c7d8e9f0g1h2' })
  id!: string;

  @ApiProperty({ enum: ['solana', 'monad'], example: 'solana' })
  chain!: string;

  @ApiProperty({ example: 'public', description: 'Always mainnet.' })
  network!: string;

  @ApiProperty({ enum: ['jupiter', 'kuru'], example: 'jupiter' })
  provider!: string;

  @ApiProperty({ enum: SwapStatus, example: 'PENDING' })
  status!: SwapStatus;

  @ApiProperty({
    example: '13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK',
    description: 'The wallet that signs, pays and receives.',
  })
  source!: string;

  @ApiProperty({
    example: 'native',
    description: '`native` (SOL / MON), or the SPL mint / ERC-20 address.',
  })
  sendAsset!: string;

  @ApiProperty({ example: '0.1' })
  sendAmount!: string;

  @ApiProperty({ example: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' })
  destAsset!: string;

  @ApiProperty({
    example: '11.87',
    description: 'Quoted output, net of the commission.',
  })
  destEstimated!: string;

  @ApiProperty({
    example: '11.81',
    description: 'On-chain minimum after slippage.',
  })
  destMin!: string;

  @ApiProperty({ example: 50 })
  feeBps!: number;

  @ApiProperty({
    example: '0.059',
    description:
      'The commission, in the destination asset (taken from the output).',
  })
  feeAmount!: string;

  @ApiProperty({ example: 50 })
  slippageBps!: number;

  @ApiProperty({ type: [SwapPathHop] })
  path!: SwapPathHop[];

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { encoding: 'base64', data: 'AQAAAAAAAAAAAAAAA…' },
    description:
      'What the wallet signs. Solana: `{ encoding: "base64", data, lastValidBlockHeight }`, ' +
      'an unsigned VersionedTransaction. Monad: `{ to, data, value, chainId }`, ' +
      'a call the wallet signs as an EIP-1559 transaction (it fills nonce and gas).',
  })
  transaction!: Record<string, unknown>;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: null,
    description:
      'Monad only, selling an ERC-20 whose allowance is short: the exact ' +
      '`approve` call `{ to, data, value, chainId }` to send and confirm first. ' +
      'The wallet broadcasts it itself.',
  })
  approval!: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'The Solana signature / EVM hash, once submitted.',
  })
  txHash!: string | null;

  @ApiProperty({ nullable: true, example: null })
  idempotencyKey!: string | null;

  @ApiProperty({
    example: '2026-10-03T12:01:00.000Z',
    description: 'Submit refuses the transaction after this; build a new swap.',
  })
  expiresAt!: Date;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class ChainSwapListEntity {
  @ApiProperty({ type: [ChainSwapEntity] })
  data!: ChainSwapEntity[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}

/** Result of `POST /v1/swaps/:id/submit` for a Solana or Monad swap. */
export class ChainSwapSubmitResultEntity {
  @ApiProperty({ example: true })
  submitted!: boolean;

  @ApiProperty({ enum: SwapStatus, example: 'SUBMITTED' })
  status!: SwapStatus;

  @ApiProperty({
    example:
      '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW',
  })
  txHash!: string;

  @ApiProperty({ type: ChainSwapEntity })
  swap!: ChainSwapEntity;
}
