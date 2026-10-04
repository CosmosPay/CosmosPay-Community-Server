import { ApiProperty, OmitType } from '@nestjs/swagger';
import { CrossChainSwapStatus } from '@generated/prisma/client';
import { CHAINS, type Chain } from '@/chains/chains.constants';

/** A token NEAR Intents can swap on one of our chains. */
export class CrossChainAssetEntity {
  @ApiProperty({ enum: CHAINS, example: 'stellar' })
  chain!: Chain;

  @ApiProperty({ example: 'USDC' })
  symbol!: string;

  @ApiProperty({
    example:
      'nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu',
    description: 'NEAR Intents’ id for the asset.',
  })
  assetId!: string;

  @ApiProperty({ example: 7 })
  decimals!: number;

  @ApiProperty({
    nullable: true,
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    description:
      'SPL mint, ERC-20 address or Stellar issuer; null for the native coin.',
  })
  contract!: string | null;
}

export class CrossChainAssetListEntity {
  @ApiProperty({ type: [CrossChainAssetEntity] })
  data!: CrossChainAssetEntity[];
}

/** One leg of a quote. */
export class CrossChainQuoteLeg {
  @ApiProperty({ enum: CHAINS, example: 'stellar' })
  chain!: Chain;

  @ApiProperty({ example: 'XLM' })
  asset!: string;

  @ApiProperty({
    example:
      'nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz',
  })
  assetId!: string;

  @ApiProperty({ nullable: true, example: null })
  contract!: string | null;

  @ApiProperty({
    example: '100',
    description:
      'Origin: the gross amount sent. Destination: the quoted amount received, net of every fee.',
  })
  amount!: string;

  @ApiProperty({
    nullable: true,
    example: '22.57',
    description: 'NEAR Intents’ USD valuation, informational only.',
  })
  amountUsd!: string | null;
}

/** The destination leg, with the minimum below which NEAR Intents refunds. */
export class CrossChainQuoteDestination extends CrossChainQuoteLeg {
  @ApiProperty({
    example: '21.967571',
    description:
      'Minimum output after slippage; below it the swap is refunded.',
  })
  minimum!: string;
}

/** The plan commission, taken by NEAR Intents out of the input as an app fee. */
export class CrossChainFeeEntity {
  @ApiProperty({ example: 50, description: 'Basis points of the input.' })
  bps!: number;

  @ApiProperty({ example: '0.5', description: 'In the origin asset.' })
  amount!: string;

  @ApiProperty({ example: 'XLM' })
  asset!: string;
}

export class CrossChainQuoteEntity {
  @ApiProperty({
    example: 'public',
    description: 'Always public: NEAR Intents prices and settles on mainnet.',
  })
  network!: string;

  @ApiProperty({ type: CrossChainQuoteLeg })
  origin!: CrossChainQuoteLeg;

  @ApiProperty({ type: CrossChainQuoteDestination })
  destination!: CrossChainQuoteDestination;

  @ApiProperty({ type: CrossChainFeeEntity })
  fee!: CrossChainFeeEntity;

  @ApiProperty({ example: 100 })
  slippageBps!: number;

  @ApiProperty({
    example: 22,
    description:
      'NEAR Intents’ estimate, in seconds after the deposit confirms.',
  })
  timeEstimateSeconds!: number;
}

/** A settlement transaction NEAR Intents reports. */
export class CrossChainTransactionEntity {
  @ApiProperty({ example: '0x9a…' })
  hash!: string;

  @ApiProperty({ example: 'https://solscan.io/tx/…' })
  explorerUrl!: string;
}

export class CrossChainSwapEntity {
  @ApiProperty({ example: 'cm1x2y3z4a5b6c7d8e9f0g1h2' })
  id!: string;

  @ApiProperty({ enum: CrossChainSwapStatus, example: 'AWAITING_DEPOSIT' })
  status!: CrossChainSwapStatus;

  @ApiProperty({
    example: 'PENDING_DEPOSIT',
    description: 'NEAR Intents’ own status word, verbatim.',
  })
  providerStatus!: string;

  @ApiProperty({ example: 'public' })
  network!: string;

  @ApiProperty({ enum: CHAINS, example: 'stellar' })
  originChain!: string;

  @ApiProperty({ example: 'XLM' })
  originAsset!: string;

  @ApiProperty({ nullable: true, example: null })
  originContract!: string | null;

  @ApiProperty({ enum: CHAINS, example: 'solana' })
  destinationChain!: string;

  @ApiProperty({ example: 'USDC' })
  destinationAsset!: string;

  @ApiProperty({
    nullable: true,
    example: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  })
  destinationContract!: string | null;

  @ApiProperty({ example: '100', description: 'Gross, in the origin asset.' })
  amountIn!: string;

  @ApiProperty({ example: 50 })
  feeBps!: number;

  @ApiProperty({ example: '0.5' })
  feeAmount!: string;

  @ApiProperty({ example: '22.189466' })
  amountOutEstimated!: string;

  @ApiProperty({ example: '21.967571' })
  amountOutMin!: string;

  @ApiProperty({ example: 100 })
  slippageBps!: number;

  @ApiProperty({ example: '13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK' })
  recipient!: string;

  @ApiProperty({
    example: 'GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG',
  })
  refundTo!: string;

  @ApiProperty({
    example: 'GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK',
    description: 'Send exactly amountIn of the origin asset here.',
  })
  depositAddress!: string;

  @ApiProperty({
    nullable: true,
    example: '188866795',
    description:
      'Stellar only, and required: attach it as a MEMO_TEXT or the deposit is lost to the swap.',
  })
  depositMemo!: string | null;

  @ApiProperty({
    example:
      'web+stellar:pay?destination=GDJ4…&amount=100&memo=188866795&memo_type=MEMO_TEXT',
    description:
      'The deposit as a wallet link on the origin chain: SEP-7 pay, Solana Pay or EIP-681.',
  })
  depositUri!: string;

  @ApiProperty({ example: 'data:image/png;base64,iVBORw0KGgo…' })
  qr!: string;

  @ApiProperty({ nullable: true, example: null })
  depositTxHash!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'Settled output, once NEAR Intents reports it.',
  })
  amountOut!: string | null;

  @ApiProperty({ nullable: true, example: null })
  refundedAmount!: string | null;

  @ApiProperty({ type: [CrossChainTransactionEntity], nullable: true })
  originTxHashes!: CrossChainTransactionEntity[] | null;

  @ApiProperty({ type: [CrossChainTransactionEntity], nullable: true })
  destinationTxHashes!: CrossChainTransactionEntity[] | null;

  @ApiProperty({ example: 22 })
  timeEstimateSeconds!: number;

  @ApiProperty({
    example: 'c5928abd-243c-4019-aebd-6cccc185cc96',
    description: 'NEAR Intents’ id for the quote, for support requests.',
  })
  correlationId!: string;

  @ApiProperty({
    example: 'ed25519:Ze6U5JbqTTbXNvU5PW2g…',
    description:
      'NEAR Intents’ signature over the quote and deposit address. Keep it: it settles a dispute.',
  })
  quoteSignature!: string;

  @ApiProperty({ nullable: true, example: null })
  idempotencyKey!: string | null;

  @ApiProperty({
    example: '2026-10-02T12:30:00.000Z',
    description: 'After this the deposit address refunds whatever arrives.',
  })
  expiresAt!: Date;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

/** A swap as the list returns it — without the derived QR. */
export class CrossChainSwapListItem extends OmitType(CrossChainSwapEntity, [
  'qr',
] as const) {}

export class CrossChainSwapListEntity {
  @ApiProperty({ type: [CrossChainSwapListItem] })
  data!: CrossChainSwapListItem[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}
