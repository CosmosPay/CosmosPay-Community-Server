import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { CHAINS } from '@/chains/chains.constants';
import { MerchantFeeEntity } from '@/common/merchant-fee/merchant-fee.entity';
import {
  CHECKOUT_THEMES,
  type CheckoutTheme,
} from '@/payment-intents/payment-intents.constants';
import {
  PaymentIntentKind,
  PaymentIntentStatus,
} from '@generated/prisma/client';

/**
 * Response shape for a payment intent. Annotated with examples so the generated
 * OpenAPI/Swagger shows a concrete sample response (not just an empty body).
 */
@ApiSchema({
  description:
    'A payment intent: one expected payment to a merchant on Stellar, Solana or Monad, with its payment link and lifecycle status.',
})
export class PaymentIntentEntity {
  @ApiProperty({
    example: 'clx9z8a1b0000abcd1234efgh',
    description: 'Payment intent id.',
  })
  id!: string;

  @ApiProperty({
    enum: PaymentIntentKind,
    example: 'TX',
    description:
      '`TX`: an unsigned Stellar transaction built for a known payer. `PAY`: a payment link any wallet can pay.',
  })
  kind!: PaymentIntentKind;

  @ApiProperty({
    enum: PaymentIntentStatus,
    example: 'PENDING',
    description:
      'Lifecycle status. `SUCCEEDED`, `FAILED` and `CANCELLED` are final; an `EXPIRED` intent still settles on a payment verified later.',
  })
  status!: PaymentIntentStatus;

  @ApiProperty({
    enum: CHAINS,
    example: 'stellar',
    description: 'Chain the payment settles on. TX intents are always Stellar.',
  })
  chain!: string;

  @ApiProperty({
    example: 'testnet',
    description:
      'Network tier, on every chain: `public` (mainnet) or `testnet` (Stellar ' +
      'testnet, Solana devnet, Monad testnet), the one the API key is for.',
  })
  network!: string;

  @ApiProperty({
    nullable: true,
    example: 'Greally…56charpublickey',
    description: 'Payer account (null for PAY intents).',
  })
  source!: string | null;

  @ApiProperty({
    example: 'GASMERCHANT…56charpublickey',
    description:
      "Payee account on the intent's chain (Stellar G..., Solana base58, Monad 0x...).",
  })
  destination!: string;

  @ApiProperty({
    nullable: true,
    example: '25.5',
    description:
      "Amount to pay, as a decimal string in the asset's units. Null for a `PAY` intent with an open amount.",
  })
  amount!: string | null;

  @ApiProperty({
    example: 'native',
    description:
      'Asset code, or "native" for the chain’s coin (XLM, SOL, MON).',
  })
  asset!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'Stellar: the issuer. Solana: the SPL mint. Monad: the ERC-20 contract.',
  })
  assetIssuer!: string | null;

  @ApiProperty({
    example: '123456789',
    description: 'Mandatory MEMO_ID (auto-generated if not provided).',
  })
  memo!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'How the payment is found off Stellar. Solana: the Solana Pay ' +
      '`reference` key. Monad with deposit addresses: the intent’s own ' +
      'deposit address, which the link pays. Null otherwise.',
  })
  chainReference!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'Deducted before the merchant is paid, in the asset’s units: the ' +
      'relayer’s fee for forwarding a Monad deposit. Null when nothing is.',
  })
  networkFee!: string | null;

  @ApiProperty({
    type: MerchantFeeEntity,
    nullable: true,
    description:
      'Your merchant fee on this payment, paid to its wallet in the same ' +
      'transaction; null when the request named none.',
  })
  merchantFee!: MerchantFeeEntity | null;

  @ApiProperty({ nullable: true, example: null, description: 'SEP-7 msg.' })
  msg!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'SEP-7 callback.',
  })
  callback!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Unsigned transaction envelope (null for PAY intents).',
    example: 'AAAAAgAAAABx…(base64 XDR)…AAAAAAAAAAA=',
  })
  xdr!: string | null;

  @ApiProperty({
    description:
      'The payment link: SEP-7 on Stellar (`tx` for TX intents, `pay` for ' +
      'PAY), a Solana Pay transfer request on Solana, EIP-681 on Monad.',
    example: 'web+stellar:tx?xdr=AAAAAgAAAABx…',
  })
  uri!: string;

  @ApiProperty({
    description: 'QR code of `uri` (PNG data URL), derived on read.',
    example: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA…',
  })
  qr!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      "The transaction reported or verified for this intent, in its chain's own form (hex lowercase); null until there is one.",
  })
  txHash!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'Your own reference for the intent, set with `PATCH`; null until set.',
  })
  reference!: string | null;

  @ApiProperty({
    enum: CHECKOUT_THEMES,
    example: 'classic',
    description:
      'Design of the hosted checkout page. `classic` when none was chosen.',
  })
  checkoutTheme!: CheckoutTheme;

  @ApiProperty({
    nullable: true,
    description:
      'When an unpaid intent expires. A payment verified later still settles it.',
    example: '2026-06-21T13:34:56.000Z',
  })
  expiresAt!: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'When the hosted checkout page (payments.cosmospay.lat/{id}) last read ' +
      'the intent while it was open: the page polls while a payer has it ' +
      'open, so a value from the last 30 seconds means someone is on the ' +
      'payment page now. Updated at most every 10 seconds; null until a page ' +
      'opened it.',
    example: '2026-06-21T12:35:10.000Z',
  })
  checkoutSeenAt!: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'When the payer last opened a wallet from the hosted checkout (its wallet link, the web wallet, the extension or Freighter), as the page reports it. Informational: the status changes only on the chain.',
    example: null,
  })
  checkoutWalletAt!: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'When the wallet last came back without paying (it declined, or the page was shown again first), as the page reports it; cleared when a wallet opens again.',
    example: null,
  })
  checkoutWalletClosedAt!: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'When the hosted checkout saw the wallet send the payment, as the page reports it: a payment on its way, before the chain confirms it.',
    example: null,
  })
  checkoutSentAt!: Date | null;

  @ApiProperty({
    example: '2026-06-21T12:34:56.000Z',
    description: 'When the intent was created (ISO 8601).',
  })
  createdAt!: Date;

  @ApiProperty({
    example: '2026-06-21T12:34:56.000Z',
    description: 'When the intent itself last changed (ISO 8601).',
  })
  updatedAt!: Date;
}

/** Creation response for a SEP-7 `tx` intent (always has source + xdr). */
@ApiSchema({
  description:
    'A Stellar SEP-7 `tx` intent as created: the unsigned envelope for the known payer, its `web+stellar:tx` link and QR.',
})
export class TxPaymentIntentEntity {
  @ApiProperty({
    example: 'clx9z8a1b0000abcd1234efgh',
    description: 'Payment intent id.',
  })
  id!: string;

  @ApiProperty({
    enum: PaymentIntentKind,
    example: 'TX',
    description: 'Always `TX` for this response.',
  })
  kind!: PaymentIntentKind;

  @ApiProperty({
    enum: PaymentIntentStatus,
    example: 'PENDING',
    description:
      'Lifecycle status. `SUCCEEDED`, `FAILED` and `CANCELLED` are final; an `EXPIRED` intent still settles on a payment verified later.',
  })
  status!: PaymentIntentStatus;

  @ApiProperty({
    enum: CHAINS,
    example: 'stellar',
    description: 'Chain the payment settles on. TX intents are always Stellar.',
  })
  chain!: string;

  @ApiProperty({
    example: 'testnet',
    description:
      'Network tier, on every chain: `public` (mainnet) or `testnet` (Stellar ' +
      'testnet, Solana devnet, Monad testnet), the one the API key is for.',
  })
  network!: string;

  @ApiProperty({
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    description: "Payer's Stellar account: the transaction source.",
  })
  source!: string;

  @ApiProperty({
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
    description: "Payee's Stellar account.",
  })
  destination!: string;

  @ApiProperty({
    example: '120.1234567',
    description: 'Amount to pay, as a decimal string (at most 7 decimals).',
  })
  amount!: string;

  @ApiProperty({
    example: 'native',
    description: 'Asset code, or `native` for XLM.',
  })
  asset!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'Issuer account of an issued asset; null for XLM.',
  })
  assetIssuer!: string | null;

  @ApiProperty({ example: '123456789', description: 'Mandatory MEMO_ID.' })
  memo!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'How the payment is found off Stellar. Solana: the Solana Pay ' +
      '`reference` key. Monad with deposit addresses: the intent’s own ' +
      'deposit address, which the link pays. Null otherwise.',
  })
  chainReference!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'Deducted before the merchant is paid, in the asset’s units: the ' +
      'relayer’s fee for forwarding a Monad deposit. Null when nothing is.',
  })
  networkFee!: string | null;

  @ApiProperty({
    type: MerchantFeeEntity,
    nullable: true,
    description:
      'Your merchant fee on this payment, paid to its wallet in the same ' +
      'transaction; null when the request named none.',
  })
  merchantFee!: MerchantFeeEntity | null;

  @ApiProperty({
    nullable: true,
    example: 'Order #24',
    description: 'SEP-7 `msg` shown to the payer in their wallet.',
  })
  msg!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'SEP-7 `callback` where the wallet POSTs the signed XDR (e.g. `url:https://...`).',
  })
  callback!: string | null;

  @ApiProperty({
    description: 'Unsigned transaction envelope (base64 XDR).',
    example: 'AAAAAgAAAABx…(base64 XDR)…AAAAAAAAAAA=',
  })
  xdr!: string;

  @ApiProperty({
    example: 'web+stellar:tx?xdr=AAAAAgAAAABx…',
    description:
      'The SEP-7 `web+stellar:tx` link carrying the unsigned envelope.',
  })
  uri!: string;

  @ApiProperty({
    example: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA…',
    description: 'QR code of `uri` (PNG data URL), derived on read.',
  })
  qr!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      "The transaction reported or verified for this intent, in its chain's own form (hex lowercase); null until there is one.",
  })
  txHash!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'Your own reference for the intent, set with `PATCH`; null until set.',
  })
  reference!: string | null;

  @ApiProperty({
    enum: CHECKOUT_THEMES,
    example: 'classic',
    description:
      'Design of the hosted checkout page. `classic` when none was chosen.',
  })
  checkoutTheme!: CheckoutTheme;

  @ApiProperty({
    nullable: true,
    description: 'When the intent expires if unpaid.',
    example: '2026-06-21T13:34:56.000Z',
  })
  expiresAt!: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'When the hosted checkout page last read the intent: null at creation.',
    example: null,
  })
  checkoutSeenAt!: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'When the payer last opened a wallet from the hosted checkout (its wallet link, the web wallet, the extension or Freighter), as the page reports it. Informational: the status changes only on the chain.',
    example: null,
  })
  checkoutWalletAt!: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'When the wallet last came back without paying (it declined, or the page was shown again first), as the page reports it; cleared when a wallet opens again.',
    example: null,
  })
  checkoutWalletClosedAt!: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'When the hosted checkout saw the wallet send the payment, as the page reports it: a payment on its way, before the chain confirms it.',
    example: null,
  })
  checkoutSentAt!: Date | null;

  @ApiProperty({
    example: '2026-06-21T12:34:56.000Z',
    description: 'When the intent was created (ISO 8601).',
  })
  createdAt!: Date;

  @ApiProperty({
    example: '2026-06-21T12:34:56.000Z',
    description: 'When the intent itself last changed (ISO 8601).',
  })
  updatedAt!: Date;
}

/** Creation response for a SEP-7 `pay` intent (no source, no xdr). */
@ApiSchema({
  description:
    'A `pay` intent as created: a payment link any wallet can pay (SEP-7 `pay` on Stellar, Solana Pay on Solana, EIP-681 on Monad) and its QR.',
})
export class PayPaymentIntentEntity {
  @ApiProperty({
    example: 'clx9z8a1b0000abcd1234efgh',
    description: 'Payment intent id.',
  })
  id!: string;

  @ApiProperty({
    enum: PaymentIntentKind,
    example: 'PAY',
    description: 'Always `PAY` for this response.',
  })
  kind!: PaymentIntentKind;

  @ApiProperty({
    enum: PaymentIntentStatus,
    example: 'PENDING',
    description:
      'Lifecycle status. `SUCCEEDED`, `FAILED` and `CANCELLED` are final; an `EXPIRED` intent still settles on a payment verified later.',
  })
  status!: PaymentIntentStatus;

  @ApiProperty({
    enum: CHAINS,
    example: 'stellar',
    description: 'Chain the payment settles on. TX intents are always Stellar.',
  })
  chain!: string;

  @ApiProperty({
    example: 'testnet',
    description:
      'Network tier, on every chain: `public` (mainnet) or `testnet` (Stellar ' +
      'testnet, Solana devnet, Monad testnet), the one the API key is for.',
  })
  network!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'Always null for PAY.',
  })
  source!: string | null;

  @ApiProperty({
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
    description:
      "Payee account on the intent's chain (Stellar G..., Solana base58, Monad 0x...).",
  })
  destination!: string;

  @ApiProperty({
    nullable: true,
    example: '120.1234567',
    description:
      "Amount to pay, as a decimal string in the asset's units. Null when the payer chooses it.",
  })
  amount!: string | null;

  @ApiProperty({
    example: 'native',
    description:
      "Asset code, or `native` for the chain's coin (XLM, SOL, MON).",
  })
  asset!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'Stellar: the issuer. Solana: the SPL mint. Monad: the ERC-20 contract. Null for the native coin.',
  })
  assetIssuer!: string | null;

  @ApiProperty({ example: '123456789', description: 'Mandatory MEMO_ID.' })
  memo!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'How the payment is found off Stellar. Solana: the Solana Pay ' +
      '`reference` key. Monad with deposit addresses: the intent’s own ' +
      'deposit address, which the link pays. Null otherwise.',
  })
  chainReference!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'Deducted before the merchant is paid, in the asset’s units: the ' +
      'relayer’s fee for forwarding a Monad deposit. Null when nothing is.',
  })
  networkFee!: string | null;

  @ApiProperty({
    type: MerchantFeeEntity,
    nullable: true,
    description:
      'Your merchant fee on this payment, paid to its wallet in the same ' +
      'transaction; null when the request named none.',
  })
  merchantFee!: MerchantFeeEntity | null;

  @ApiProperty({
    nullable: true,
    example: 'pay me with lumens',
    description:
      'Message shown to the payer in their wallet: SEP-7 `msg` on Stellar, the Solana Pay `message` on Solana.',
  })
  msg!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'SEP-7 `callback` (e.g. `url:https://...`). Stellar only.',
  })
  callback!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'Always null for PAY.',
  })
  xdr!: string | null;

  @ApiProperty({
    example:
      'web+stellar:pay?destination=GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO&amount=120.1234567',
    description:
      'The payment link: SEP-7 `web+stellar:pay` on Stellar, Solana Pay on Solana, EIP-681 on Monad. With a merchant fee it is the hosted checkout on Stellar and a Solana Pay transaction request on Solana.',
  })
  uri!: string;

  @ApiProperty({
    example: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA…',
    description: 'QR code of `uri` (PNG data URL), derived on read.',
  })
  qr!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      "The transaction reported or verified for this intent, in its chain's own form (hex lowercase); null until there is one.",
  })
  txHash!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'Your own reference for the intent, set with `PATCH`; null until set.',
  })
  reference!: string | null;

  @ApiProperty({
    enum: CHECKOUT_THEMES,
    example: 'classic',
    description:
      'Design of the hosted checkout page. `classic` when none was chosen.',
  })
  checkoutTheme!: CheckoutTheme;

  @ApiProperty({
    nullable: true,
    description: 'When the intent expires if unpaid.',
    example: '2026-06-21T13:34:56.000Z',
  })
  expiresAt!: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'When the hosted checkout page last read the intent: null at creation.',
    example: null,
  })
  checkoutSeenAt!: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'When the payer last opened a wallet from the hosted checkout (its wallet link, the web wallet, the extension or Freighter), as the page reports it. Informational: the status changes only on the chain.',
    example: null,
  })
  checkoutWalletAt!: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'When the wallet last came back without paying (it declined, or the page was shown again first), as the page reports it; cleared when a wallet opens again.',
    example: null,
  })
  checkoutWalletClosedAt!: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'When the hosted checkout saw the wallet send the payment, as the page reports it: a payment on its way, before the chain confirms it.',
    example: null,
  })
  checkoutSentAt!: Date | null;

  @ApiProperty({
    example: '2026-06-21T12:34:56.000Z',
    description: 'When the intent was created (ISO 8601).',
  })
  createdAt!: Date;

  @ApiProperty({
    example: '2026-06-21T12:34:56.000Z',
    description: 'When the intent itself last changed (ISO 8601).',
  })
  updatedAt!: Date;
}

@ApiSchema({
  description:
    "One page of the consumer's payment intents on the key's network, newest first.",
})
export class PaymentIntentListEntity {
  @ApiProperty({
    type: [PaymentIntentEntity],
    description: 'The payment intents on this page, newest first.',
  })
  data!: PaymentIntentEntity[];

  @ApiProperty({
    example: 1,
    description: 'Number of intents matching the filters, across every page.',
  })
  total!: number;

  @ApiProperty({ example: 20, description: 'Page size applied (1 to 100).' })
  take!: number;

  @ApiProperty({
    example: 0,
    description: 'Number of intents skipped before this page.',
  })
  skip!: number;
}

@ApiSchema({
  description: 'Result of checking a transaction against a payment intent.',
})
export class ValidationOutcomeEntity {
  @ApiProperty({
    example: true,
    description:
      'True when the intent is `SUCCEEDED`: this transaction paid it, or it was already paid.',
  })
  valid!: boolean;

  @ApiProperty({
    enum: PaymentIntentStatus,
    example: 'SUCCEEDED',
    description: 'The intent status after the check.',
  })
  status!: PaymentIntentStatus;

  @ApiProperty({
    required: false,
    nullable: true,
    example: null,
    description: 'Why validation failed, when `valid` is false.',
  })
  reason?: string;

  @ApiProperty({
    type: PaymentIntentEntity,
    required: false,
    description:
      'The intent after the check; omitted when the check changed nothing.',
  })
  paymentIntent?: PaymentIntentEntity;
}

@ApiSchema({ description: 'Confirmation that a payment intent was deleted.' })
export class DeletedEntity {
  @ApiProperty({
    example: 'clx9z8a1b0000abcd1234efgh',
    description: 'Id of the deleted payment intent.',
  })
  id!: string;

  @ApiProperty({ example: true, description: 'Always true.' })
  deleted!: boolean;
}

@ApiSchema({
  description: "One status change in a payment intent's audit trail.",
})
export class PaymentIntentTransitionEntity {
  @ApiProperty({ example: 'clxtransition0001', description: 'Transition id.' })
  id!: string;

  @ApiProperty({
    example: 'clx9z8a1b0000abcd1234efgh',
    description: 'Id of the payment intent that changed.',
  })
  intentId!: string;

  @ApiProperty({
    enum: PaymentIntentStatus,
    example: 'PENDING',
    description: 'Status before the change.',
  })
  fromStatus!: PaymentIntentStatus;

  @ApiProperty({
    enum: PaymentIntentStatus,
    example: 'SUBMITTED',
    description: 'Status after the change.',
  })
  toStatus!: PaymentIntentStatus;

  @ApiProperty({
    required: false,
    nullable: true,
    example: '3389e9f0…',
    description: 'The transaction the change carried, if any.',
  })
  txHash!: string | null;

  @ApiProperty({
    example: 'api',
    description: 'api | validate | observer | system',
  })
  actor!: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Why the status changed (e.g. `on-chain payment confirmed`), when recorded.',
  })
  reason!: string | null;

  @ApiProperty({ description: 'When the change happened (ISO 8601).' })
  createdAt!: Date;
}

@ApiSchema({ description: "A payment intent's status-transition history." })
export class PaymentIntentTransitionListEntity {
  @ApiProperty({
    type: [PaymentIntentTransitionEntity],
    description: 'Every status change, oldest first.',
  })
  // Returned as a bare array from the controller; Swagger documents the item shape.
  data!: PaymentIntentTransitionEntity[];
}
