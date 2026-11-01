import { ApiProperty, ApiSchema, OmitType } from '@nestjs/swagger';
import { ApiPublicTokenProperty } from '@/common/decorators/api-record-token.decorator';
import { MerchantFeeEntity } from '@/common/merchant-fee/merchant-fee.entity';
import { CrossChainSwapStatus } from '@generated/prisma/client';
import {
  CROSS_CHAIN_NETWORK_IDS,
  type CrossChainNetworkId,
} from '@/cross-chain-swaps/cross-chain-swaps.constants';

/** A token NEAR Intents can swap on one of the networks this service reaches. */
@ApiSchema({
  description:
    'A token NEAR Intents can swap, on one of the networks cross-chain swaps reach.',
})
export class CrossChainAssetEntity {
  @ApiProperty({
    enum: CROSS_CHAIN_NETWORK_IDS,
    example: 'stellar',
    description:
      'The network id a request names it by (originChain / destinationChain).',
  })
  chain!: CrossChainNetworkId;

  @ApiProperty({
    example: 'Stellar',
    description: 'The network, by name: for display.',
  })
  chainName!: string;

  @ApiProperty({
    example: 'USDC',
    description: "The token's symbol, as NEAR Intents lists it.",
  })
  symbol!: string;

  @ApiProperty({
    example:
      'nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu',
    description: 'NEAR Intents’ id for the asset.',
  })
  assetId!: string;

  @ApiProperty({
    example: 7,
    description:
      "The token's decimal places on its network, as NEAR Intents lists them.",
  })
  decimals!: number;

  @ApiProperty({
    nullable: true,
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    description:
      'The token on its network (SPL mint, ERC-20 address, Stellar issuer, ' +
      'Sui coin type, TON jetton master, ...); null for the native coin.',
  })
  contract!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0.999538,
    description:
      'NEAR Intents’ reference price in USD, indicative only: for showing an ' +
      'estimate before a quote. It may be a few minutes old, and every amount ' +
      'still comes from a quote. Null when NEAR Intents lists none.',
  })
  priceUsd!: number | null;
}

@ApiSchema({
  description:
    'The assets cross-chain swaps can use, as `GET /v1/cross-chain-swaps/assets` lists them.',
})
export class CrossChainAssetListEntity {
  @ApiProperty({
    type: [CrossChainAssetEntity],
    description:
      'Every asset NEAR Intents still trades: a token it tags deprecated or ' +
      'lists with no price is left out.',
  })
  data!: CrossChainAssetEntity[];
}

/** One leg of a quote. */
@ApiSchema({
  description:
    'One leg of a cross-chain swap quote: an asset on one network and its amount.',
})
export class CrossChainQuoteLeg {
  @ApiProperty({
    enum: CROSS_CHAIN_NETWORK_IDS,
    example: 'stellar',
    description: "The leg's network id.",
  })
  chain!: CrossChainNetworkId;

  @ApiProperty({
    example: 'XLM',
    description: "The asset's symbol, as NEAR Intents lists it.",
  })
  asset!: string;

  @ApiProperty({
    example:
      'nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz',
    description: "NEAR Intents' id for the asset.",
  })
  assetId!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      "The token's contract on its network; null for the native coin.",
  })
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
@ApiSchema({
  description:
    'The destination leg of a cross-chain swap quote, with the minimum ' +
    'output below which NEAR Intents refunds.',
})
export class CrossChainQuoteDestination extends CrossChainQuoteLeg {
  @ApiProperty({
    example: '21.967571',
    description:
      'Minimum output after slippage; below it the swap is refunded.',
  })
  minimum!: string;
}

/** The plan commission, taken by NEAR Intents out of the input as an app fee. */
@ApiSchema({
  description:
    'The plan commission on a cross-chain swap, which NEAR Intents takes out ' +
    'of the input as an app fee.',
})
export class CrossChainFeeEntity {
  @ApiProperty({ example: 50, description: 'Basis points of the input.' })
  bps!: number;

  @ApiProperty({ example: '0.5', description: 'In the origin asset.' })
  amount!: string;

  @ApiProperty({
    example: 'XLM',
    description: "The origin asset's symbol: the commission is paid in it.",
  })
  asset!: string;
}

@ApiSchema({
  description:
    'Response of `POST /v1/cross-chain-swaps/quote`: the price of a ' +
    'cross-chain swap through NEAR Intents. Nothing is persisted.',
})
export class CrossChainQuoteEntity {
  @ApiProperty({
    example: 'public',
    description: 'Always public: NEAR Intents prices and settles on mainnet.',
  })
  network!: string;

  @ApiProperty({
    type: CrossChainQuoteLeg,
    description: 'The origin leg: what the payer deposits.',
  })
  origin!: CrossChainQuoteLeg;

  @ApiProperty({
    type: CrossChainQuoteDestination,
    description:
      'The destination leg: what the recipient receives, with its minimum.',
  })
  destination!: CrossChainQuoteDestination;

  @ApiProperty({
    type: CrossChainFeeEntity,
    description: 'The plan commission, in the origin asset.',
  })
  fee!: CrossChainFeeEntity;

  @ApiProperty({
    type: MerchantFeeEntity,
    nullable: true,
    description:
      'The merchant fee NEAR Intents will pay, in the origin asset; null without one.',
  })
  merchantFee!: MerchantFeeEntity | null;

  @ApiProperty({
    example: 100,
    description:
      'Slippage tolerance used for the destination minimum, in basis points (100 = 1%).',
  })
  slippageBps!: number;

  @ApiProperty({
    example: 22,
    description:
      'NEAR Intents’ estimate, in seconds after the deposit confirms.',
  })
  timeEstimateSeconds!: number;
}

/** A settlement transaction NEAR Intents reports. */
@ApiSchema({
  description:
    'A settlement transaction NEAR Intents reports, with its explorer link.',
})
export class CrossChainTransactionEntity {
  @ApiProperty({
    example: '0x9a…',
    description: 'The transaction id on its chain, as NEAR Intents reports it.',
  })
  hash!: string;

  @ApiProperty({
    example: 'https://solscan.io/tx/…',
    description:
      'A block explorer link to the transaction, as NEAR Intents reports it.',
  })
  explorerUrl!: string;
}

@ApiSchema({
  description:
    'A cross-chain swap settled by NEAR Intents: the deposit request the ' +
    'payer pays, and the settlement as NEAR Intents reports it.',
})
export class CrossChainSwapEntity {
  @ApiProperty({
    example: 'cm1x2y3z4a5b6c7d8e9f0g1h2',
    description: "The swap's id.",
  })
  id!: string;

  @ApiProperty({
    enum: CrossChainSwapStatus,
    example: 'AWAITING_DEPOSIT',
    description:
      "The swap's status, mapped from NEAR Intents' `providerStatus`; " +
      'EXPIRED means the deadline passed with nothing deposited.',
  })
  status!: CrossChainSwapStatus;

  @ApiProperty({
    example: 'PENDING_DEPOSIT',
    description: 'NEAR Intents’ own status word, verbatim.',
  })
  providerStatus!: string;

  @ApiProperty({
    example: 'public',
    description: 'Always `public`: NEAR Intents settles on mainnet only.',
  })
  network!: string;

  @ApiProperty({
    enum: CROSS_CHAIN_NETWORK_IDS,
    example: 'stellar',
    description: 'The network the payer deposits on.',
  })
  originChain!: string;

  @ApiProperty({
    example: 'XLM',
    description: "The sold asset's symbol, as NEAR Intents lists it.",
  })
  originAsset!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      "The sold token's contract on its network; null for the native coin.",
  })
  originContract!: string | null;

  @ApiProperty({
    enum: CROSS_CHAIN_NETWORK_IDS,
    example: 'solana',
    description: 'The network the recipient is paid on.',
  })
  destinationChain!: string;

  @ApiProperty({
    example: 'USDC',
    description: "The bought asset's symbol, as NEAR Intents lists it.",
  })
  destinationAsset!: string;

  @ApiProperty({
    nullable: true,
    example: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    description:
      "The bought token's contract on its network; null for the native coin.",
  })
  destinationContract!: string | null;

  @ApiProperty({ example: '100', description: 'Gross, in the origin asset.' })
  amountIn!: string;

  @ApiProperty({
    example: 50,
    description: 'The plan commission rate, in basis points of `amountIn`.',
  })
  feeBps!: number;

  @ApiProperty({
    example: '0.5',
    description:
      'The plan commission, as a decimal string in the origin asset, which ' +
      'NEAR Intents takes as an app fee.',
  })
  feeAmount!: string;

  @ApiProperty({
    type: MerchantFeeEntity,
    nullable: true,
    description:
      'The merchant fee NEAR Intents pays as an app fee; null when the request named none.',
  })
  merchantFee!: MerchantFeeEntity | null;

  @ApiProperty({
    example: '22.189466',
    description:
      'The quoted output, as a decimal string in the destination asset, net ' +
      'of the commission.',
  })
  amountOutEstimated!: string;

  @ApiProperty({
    example: '21.967571',
    description:
      'Minimum output after slippage, as a decimal string in the destination ' +
      'asset; below it the swap is refunded.',
  })
  amountOutMin!: string;

  @ApiProperty({
    example: 100,
    description:
      'Slippage tolerance used to derive `amountOutMin`, in basis points.',
  })
  slippageBps!: number;

  @ApiProperty({
    example: '13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK',
    description: 'Who receives the output, on `destinationChain`.',
  })
  recipient!: string;

  @ApiProperty({
    example: 'GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG',
    description:
      'Where a failed or late deposit is refunded, on `originChain`.',
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
      'Required whenever it is set: attach it to the deposit or the deposit is ' +
      'lost to the swap. Always set on Stellar (a MEMO_TEXT); on another chain ' +
      'only if NEAR Intents issues one.',
  })
  depositMemo!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example:
      'web+stellar:pay?destination=GDJ4…&amount=100&memo=188866795&memo_type=MEMO_TEXT',
    description:
      'The deposit as a wallet link on the origin chain, where the chain has a ' +
      'wallet-link standard: SEP-7 pay, Solana Pay, EIP-681, BIP-21 style ' +
      '(bitcoin:, litecoin:, dogecoin:, bitcoincash:, dash:, zcash:), ton:// ' +
      'transfer or CIP-13 web+cardano:. Null means: pay depositAddress (and ' +
      'depositMemo, if set) with any wallet of that chain.',
  })
  depositUri!: string | null;

  @ApiProperty({
    example: 'data:image/png;base64,iVBORw0KGgo…',
    description:
      'PNG data URL of a QR code: of depositUri when there is one, else of ' +
      'depositAddress.',
  })
  qr!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'The deposit transaction reported through ' +
      '`POST /v1/cross-chain-swaps/{id}/deposit`; null until one is reported.',
  })
  depositTxHash!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'Settled output, once NEAR Intents reports it.',
  })
  amountOut!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'The amount refunded to `refundTo`, as a decimal string in the origin ' +
      'asset, once NEAR Intents reports a refund; null otherwise.',
  })
  refundedAmount!: string | null;

  @ApiProperty({
    type: [CrossChainTransactionEntity],
    nullable: true,
    description:
      'Transactions NEAR Intents reports on the origin chain; null until it reports any.',
  })
  originTxHashes!: CrossChainTransactionEntity[] | null;

  @ApiProperty({
    type: [CrossChainTransactionEntity],
    nullable: true,
    description:
      'Transactions NEAR Intents reports on the destination chain; null until it reports any.',
  })
  destinationTxHashes!: CrossChainTransactionEntity[] | null;

  @ApiProperty({
    example: 22,
    description:
      "NEAR Intents' estimate, in seconds after the deposit confirms.",
  })
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

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'Client idempotency key when supplied via the Idempotency-Key header or ' +
      'body; null otherwise.',
  })
  idempotencyKey!: string | null;

  @ApiProperty({
    example: '2026-10-02T12:30:00.000Z',
    description: 'After this the deposit address refunds whatever arrives.',
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

/** A swap as the list returns it — without the derived QR. */
/** What `POST /v1/cross-chain-swaps` answers: the swap, and its read token. */
@ApiSchema({
  description:
    'What `POST /v1/cross-chain-swaps` answers: the swap and, for the shared ' +
    'public key, its read token.',
})
export class CrossChainSwapCreatedEntity extends CrossChainSwapEntity {
  @ApiPublicTokenProperty()
  publicToken?: string;
}

@ApiSchema({
  description:
    'A cross-chain swap as `GET /v1/cross-chain-swaps` lists it: the stored ' +
    'row, without the QR.',
})
export class CrossChainSwapListItem extends OmitType(CrossChainSwapEntity, [
  'qr',
] as const) {}

@ApiSchema({ description: 'A page of cross-chain swaps, newest first.' })
export class CrossChainSwapListEntity {
  @ApiProperty({
    type: [CrossChainSwapListItem],
    description: 'This page of swaps, newest first.',
  })
  data!: CrossChainSwapListItem[];

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
