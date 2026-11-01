import { ApiProperty, ApiSchema, OmitType } from '@nestjs/swagger';
import { SwapStatus } from '@generated/prisma/client';
import { ApiPublicTokenProperty } from '@/common/decorators/api-record-token.decorator';
import { MerchantFeeEntity } from '@/common/merchant-fee/merchant-fee.entity';

/** One asset hop on the chosen path (empty array = direct order-book swap). */
@ApiSchema({
  description:
    "One intermediate asset on a swap's route: a Stellar asset (code and " +
    'issuer), or an SPL mint on Solana with a null issuer.',
})
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
@ApiSchema({
  description:
    'An asset and an amount of it, as a swap quote reports the gross input ' +
    'and the amount routed.',
})
export class SwapAssetAmount {
  @ApiProperty({ example: 'native', description: 'Asset code, or "native".' })
  asset!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'Issuer of a non-native Stellar asset; null for native XLM, and always ' +
      'null on Solana and Monad.',
  })
  issuer!: string | null;

  @ApiProperty({
    example: '100',
    description: "The amount, as a decimal string in the asset's own units.",
  })
  amount!: string;
}

/** The platform fee taken from the source asset. */
@ApiSchema({
  description:
    'The plan commission on a swap quote: taken from the source amount on ' +
    'Stellar, from the output on Solana and Monad.',
})
export class SwapFeeBreakdown {
  @ApiProperty({
    example: 'native',
    description:
      'The asset the commission is paid in: the source asset on Stellar, the ' +
      'bought asset on Solana and Monad.',
  })
  asset!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'Issuer of that asset when it is a non-native Stellar asset; null otherwise.',
  })
  issuer!: string | null;

  @ApiProperty({
    example: '0.5',
    description: "The commission, as a decimal string in that asset's units.",
  })
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
@ApiSchema({
  description:
    'The bought asset of a swap quote, with its estimated output and the ' +
    'slippage-protected minimum.',
})
export class SwapDestinationQuote {
  @ApiProperty({
    example: 'USDC',
    description:
      'The asset bought: a Stellar asset code or `native`; on Solana and ' +
      'Monad, `native` or the mint / ERC-20 address.',
  })
  asset!: string;

  @ApiProperty({
    nullable: true,
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTR6F3DSZL5A3W4G4M4N4A5U4QY3T6',
    description:
      'Issuer of a non-native Stellar asset; null for native XLM, and always ' +
      'null on Solana and Monad.',
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
      'On-chain minimum (destMin) after slippage: swap reverts below it.',
  })
  minimum!: string;

  @ApiProperty({
    example: 50,
    description: 'Slippage tolerance used for `minimum`, in basis points.',
  })
  slippageBps!: number;
}

/** Response of `POST /v1/swaps/quote` — pricing only, nothing is persisted. */
@ApiSchema({
  description:
    'Response of `POST /v1/swaps/quote`: the price of a same-chain swap. ' +
    'Nothing is persisted.',
})
export class SwapQuoteEntity {
  @ApiProperty({
    example: 'testnet',
    description:
      'The network the quote was priced on: `public` or `testnet` on Stellar, ' +
      'following the API key; always `public` on Solana and Monad.',
  })
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

  @ApiProperty({
    type: SwapFeeBreakdown,
    description:
      'The plan commission: in the source asset on Stellar, in the bought ' +
      'asset on Solana and Monad.',
  })
  fee!: SwapFeeBreakdown;

  @ApiProperty({
    type: SwapAssetAmount,
    description: 'Net amount routed (input − fee).',
  })
  swap!: SwapAssetAmount;

  @ApiProperty({
    type: MerchantFeeEntity,
    nullable: true,
    required: false,
    description:
      'The merchant fee the request named, in the source asset; null without ' +
      'one. With `paidBy: payer` the source sends `source.amount` plus it.',
  })
  merchantFee?: MerchantFeeEntity | null;

  @ApiProperty({
    type: SwapDestinationQuote,
    description:
      'The bought asset, with the estimated output and the on-chain minimum.',
  })
  destination!: SwapDestinationQuote;

  @ApiProperty({
    type: [SwapPathHop],
    description: 'Intermediate hops (may be empty).',
  })
  path!: SwapPathHop[];
}

/** The asset a swap's transaction adds the source's trustline for. */
@ApiSchema({
  description:
    "The asset a Stellar swap's transaction adds the source's trustline for, " +
    'with a `changeTrust` as its first operation.',
})
export class SwapTrustline {
  @ApiProperty({
    example: 'USDC',
    description: 'Code of the asset the trustline is added for.',
  })
  code!: string;

  @ApiProperty({
    example: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    description: 'Issuer account of that asset.',
  })
  issuer!: string;
}

/** A persisted swap (the `swap` table row) plus its derived QR. */
@ApiSchema({
  description:
    'A Stellar swap: the stored row with the unsigned transaction (base64 ' +
    'XDR, SEP-7 `uri` and QR) for `source` to sign.',
})
export class SwapEntity {
  @ApiProperty({
    example: 'clx9z8a1b0000abcd1234efgh',
    description: "The swap's id.",
  })
  id!: string;

  @ApiProperty({
    enum: SwapStatus,
    example: 'PENDING',
    description:
      "The swap's status: PENDING (built, not yet submitted), SUBMITTED, " +
      'SUCCEEDED, FAILED or EXPIRED.',
  })
  status!: SwapStatus;

  @ApiProperty({
    example: 'testnet',
    description:
      'The Stellar network the swap is on: `public` or `testnet`, following ' +
      'the API key.',
  })
  network!: string;

  @ApiProperty({
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    description:
      'The account that pays for and signs the swap (the transaction source).',
  })
  source!: string;

  @ApiProperty({
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    description:
      'The account credited the bought asset; equal to `source` for a self-swap.',
  })
  destination!: string;

  @ApiProperty({
    example: 'native',
    description: 'The asset sold: its code, or `native` for XLM.',
  })
  sendAsset!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'Issuer of the sold asset; null for native XLM.',
  })
  sendAssetIssuer!: string | null;

  @ApiProperty({ example: '100', description: 'Gross source amount.' })
  sendAmount!: string;

  @ApiProperty({
    example: '0.5',
    description:
      'The plan commission, as a decimal string in the sold asset: `feeBps` ' +
      'of `sendAmount`, rounded down.',
  })
  feeAmount!: string;

  @ApiProperty({
    example: 50,
    description: 'The plan commission rate, in basis points (50 = 0.5%).',
  })
  feeBps!: number;

  @ApiProperty({
    example: '99.5',
    description: 'Amount routed through the DEX/AMM.',
  })
  swapAmount!: string;

  @ApiProperty({
    type: MerchantFeeEntity,
    nullable: true,
    description:
      'The merchant fee this swap pays, by its own payment in the same ' +
      'transaction; null when the request named none.',
  })
  merchantFee!: MerchantFeeEntity | null;

  @ApiProperty({
    example: 'USDC',
    description: 'The asset bought: its code, or `native` for XLM.',
  })
  destAsset!: string;

  @ApiProperty({
    nullable: true,
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTR6F3DSZL5A3W4G4M4N4A5U4QY3T6',
    description: 'Issuer of the bought asset; null for native XLM.',
  })
  destAssetIssuer!: string | null;

  @ApiProperty({
    example: '24.81',
    description:
      'The quoted output at build time, as a decimal string in the bought asset.',
  })
  destEstimated!: string;

  @ApiProperty({
    example: '24.68595',
    description:
      "The on-chain minimum output after slippage (the path payment's " +
      'destMin), as a decimal string: the swap reverts below it.',
  })
  destMin!: string;

  @ApiProperty({
    example: 50,
    description:
      'Slippage tolerance used to derive `destMin`, in basis points.',
  })
  slippageBps!: number;

  @ApiProperty({
    type: [SwapPathHop],
    description: 'Intermediate assets of the route; empty when it has none.',
  })
  path!: SwapPathHop[];

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      "The caller's MEMO_ID (numeric uint64) on the transaction; null when " +
      'none was supplied.',
  })
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
    type: SwapTrustline,
    nullable: true,
    example: null,
    description:
      'The bought asset, when the source receives it and does not trust it yet: ' +
      'the transaction then starts with a `changeTrust` for it, so the one ' +
      'signature adds the trustline and makes the swap. Adding it locks another ' +
      '0.5 XLM base reserve in the account, which a wallet should tell its user ' +
      'before they sign. Null when no trustline is added (XLM bought, the ' +
      'account already trusts the asset, or the destination is another account). ' +
      'Read from the transaction itself.',
  })
  trustline!: SwapTrustline | null;

  @ApiProperty({
    description: 'Unsigned transaction envelope (base64 XDR) to sign.',
    example: 'AAAAAgAAAABx…(base64 XDR)…AAAAAAAAAAA=',
  })
  xdr!: string;

  @ApiProperty({
    example: 'web+stellar:tx?xdr=AAAAAgAAAABx…',
    description:
      'SEP-7 `web+stellar:tx` URI carrying `xdr`, for a wallet to open and sign.',
  })
  uri!: string;

  @ApiProperty({
    description: 'Deterministic transaction hash (verified on submit).',
    example: '3389e9f0...64hex',
  })
  txHash!: string;

  @ApiProperty({
    example: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA…',
    description: 'PNG data URL of a QR code of `uri`.',
  })
  qr!: string;

  @ApiProperty({
    nullable: true,
    description:
      "When the envelope's time bounds close; submit refuses it afterwards.",
    example: '2026-06-29T12:39:56.000Z',
  })
  expiresAt!: Date | null;

  @ApiProperty({
    example: '2026-06-29T12:34:56.000Z',
    description: 'When the swap was created (ISO 8601 date-time).',
  })
  createdAt!: Date;

  @ApiProperty({
    example: '2026-06-29T12:34:56.000Z',
    description: 'When the swap was last updated (ISO 8601 date-time).',
  })
  updatedAt!: Date;
}

/** What `POST /v1/swaps` answers for a Stellar swap: the swap, and its read token. */
@ApiSchema({
  description:
    'What `POST /v1/swaps` answers for a Stellar swap: the swap and, for the ' +
    'shared public key, its read token.',
})
export class SwapCreatedEntity extends SwapEntity {
  @ApiPublicTokenProperty()
  publicToken?: string;
}

/**
 * A swap as `GET /v1/swaps` lists it: the stored row. The QR, the commission
 * label and the added trustline are derived by the single read, not rendered
 * for every row of a page: fetch the swap for them. Declaring list items as
 * {@link SwapEntity} made generated clients type fields the list never sent.
 */
@ApiSchema({
  description:
    'A Stellar swap as `GET /v1/swaps` lists it: the stored row, without the ' +
    'QR, commission label and added trustline (read the swap by id for those).',
})
export class SwapListItemEntity extends OmitType(SwapEntity, [
  'qr',
  'commissionMemo',
  'trustline',
] as const) {}

@ApiSchema({ description: 'A page of Stellar swaps, newest first.' })
export class SwapListEntity {
  @ApiProperty({
    type: [SwapListItemEntity],
    description: 'This page of swaps, newest first.',
  })
  data!: SwapListItemEntity[];

  @ApiProperty({
    example: 1,
    description: 'How many swaps match the filter, across every page.',
  })
  total!: number;

  @ApiProperty({ example: 20, description: 'The page size used.' })
  take!: number;

  @ApiProperty({
    example: 0,
    description: 'How many swaps were skipped before this page.',
  })
  skip!: number;
}

/** Result of `POST /v1/swaps/:id/submit`. */
@ApiSchema({
  description: 'Result of `POST /v1/swaps/{id}/submit` for a Stellar swap.',
})
export class SwapSubmitResultEntity {
  @ApiProperty({
    example: true,
    description:
      'True when the transaction settled (`status` SUCCEEDED); false when ' +
      'the network rejected this broadcast (see `reason`).',
  })
  submitted!: boolean;

  @ApiProperty({
    enum: SwapStatus,
    example: 'SUCCEEDED',
    description:
      "The swap's status after the submit: SUCCEEDED, FAILED or SUBMITTED.",
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
    example: ['op_under_dest_min'],
    description: 'Horizon transaction/operation result codes on a rejection.',
  })
  resultCodes?: string[];

  @ApiProperty({ type: SwapEntity, description: 'The swap after the submit.' })
  swap!: SwapEntity;
}

/**
 * A Solana or Monad swap (`chain_swap`): built by Jupiter or Kuru Flow, signed
 * by the wallet, relayed by this service. Returned by `/v1/swaps` when the
 * request names `chain: solana | monad`.
 */
@ApiSchema({
  description:
    'A Solana or Monad swap: built by Jupiter or Kuru Flow, signed by the ' +
    'wallet, relayed by this service. Returned by `/v1/swaps` when the ' +
    'request names `chain: solana | monad`.',
})
export class ChainSwapEntity {
  @ApiProperty({
    example: 'cm1x2y3z4a5b6c7d8e9f0g1h2',
    description: "The swap's id.",
  })
  id!: string;

  @ApiProperty({
    enum: ['solana', 'monad'],
    example: 'solana',
    description: 'The chain the swap runs on.',
  })
  chain!: string;

  @ApiProperty({ example: 'public', description: 'Always mainnet.' })
  network!: string;

  @ApiProperty({
    enum: ['jupiter', 'kuru'],
    example: 'jupiter',
    description:
      'The aggregator that priced and built the swap: `jupiter` on Solana, ' +
      '`kuru` (Kuru Flow) on Monad.',
  })
  provider!: string;

  @ApiProperty({
    enum: SwapStatus,
    example: 'PENDING',
    description:
      "The swap's status: PENDING (built, not yet submitted), SUBMITTED " +
      '(broadcast, awaiting the chain), SUCCEEDED, FAILED or EXPIRED.',
  })
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

  @ApiProperty({
    example: '0.1',
    description:
      'Gross amount of the sold asset, as a decimal string in its own units.',
  })
  sendAmount!: string;

  @ApiProperty({
    example: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    description:
      'The asset bought: `native` (SOL / MON), or the SPL mint / ERC-20 address.',
  })
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

  @ApiProperty({
    example: 50,
    description:
      'The plan commission rate, in basis points (50 = 0.5%), taken from the output.',
  })
  feeBps!: number;

  @ApiProperty({
    example: '0.059',
    description:
      'The commission, in the destination asset (taken from the output).',
  })
  feeAmount!: string;

  @ApiProperty({
    example: 50,
    description:
      'Slippage tolerance used to derive `destMin`, in basis points.',
  })
  slippageBps!: number;

  @ApiProperty({
    type: [SwapPathHop],
    description:
      'Intermediate assets of the route: SPL mints on Solana (with a null ' +
      'issuer); always empty on Monad.',
  })
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

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'Client idempotency key when supplied via the Idempotency-Key header or ' +
      'body; null otherwise.',
  })
  idempotencyKey!: string | null;

  @ApiProperty({
    example: '2026-10-03T12:01:00.000Z',
    description: 'Submit refuses the transaction after this; build a new swap.',
  })
  expiresAt!: Date;

  @ApiProperty({
    description: 'When the swap was created (ISO 8601 date-time).',
  })
  createdAt!: Date;

  @ApiProperty({
    description: 'When the swap was last updated (ISO 8601 date-time).',
  })
  updatedAt!: Date;
}

/** What `POST /v1/swaps` answers for a Solana or Monad swap, with its read token. */
@ApiSchema({
  description:
    'What `POST /v1/swaps` answers for a Solana or Monad swap: the swap and, ' +
    'for the shared public key, its read token.',
})
export class ChainSwapCreatedEntity extends ChainSwapEntity {
  @ApiPublicTokenProperty()
  publicToken?: string;
}

@ApiSchema({ description: 'A page of Solana or Monad swaps, newest first.' })
export class ChainSwapListEntity {
  @ApiProperty({
    type: [ChainSwapEntity],
    description: 'This page of swaps, newest first.',
  })
  data!: ChainSwapEntity[];

  @ApiProperty({
    example: 1,
    description: 'How many swaps match the filter, across every page.',
  })
  total!: number;

  @ApiProperty({ example: 20, description: 'The page size used.' })
  take!: number;

  @ApiProperty({
    example: 0,
    description: 'How many swaps were skipped before this page.',
  })
  skip!: number;
}

/** Result of `POST /v1/swaps/:id/submit` for a Solana or Monad swap. */
@ApiSchema({
  description:
    'Result of `POST /v1/swaps/{id}/submit` for a Solana or Monad swap.',
})
export class ChainSwapSubmitResultEntity {
  @ApiProperty({
    example: true,
    description:
      'Always true: the node accepted the broadcast. A refusal is a 400 ' +
      '`transaction_rejected` instead.',
  })
  submitted!: boolean;

  @ApiProperty({
    enum: SwapStatus,
    example: 'SUBMITTED',
    description:
      "The swap's status after the broadcast, normally SUBMITTED until the " +
      'observer sees the transaction settle.',
  })
  status!: SwapStatus;

  @ApiProperty({
    example:
      '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW',
    description:
      'The broadcast transaction: the Solana signature or the EVM transaction hash.',
  })
  txHash!: string;

  @ApiProperty({
    type: ChainSwapEntity,
    description: 'The swap after the broadcast.',
  })
  swap!: ChainSwapEntity;
}
