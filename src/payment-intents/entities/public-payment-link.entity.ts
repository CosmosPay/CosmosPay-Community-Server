import { ApiProperty } from '@nestjs/swagger';
import { CHAINS, type Chain } from '@/chains/chains.constants';
import {
  PaymentIntentKind,
  PaymentIntentStatus,
} from '@generated/prisma/client';

/**
 * A payment intent as its PAYER may see it: what `GET /v1/payment-links/{id}`
 * answers, with no API key, to anyone who holds the link.
 *
 * Deliberately not `PaymentIntentEntity` minus a few fields. That one is the
 * merchant's view and carries what a payer must never be handed — the owning
 * consumer, the payer's `source`, the envelope, the merchant's `reference` and
 * `callback`, the merchant's own address when the payer pays a deposit address.
 * This class lists what a checkout page needs and nothing else, and
 * `toPublicPaymentLink` builds it field by field, so a column added to
 * `payment_intent` later reaches this response only by being added here.
 *
 * The nullable fields name `type: String` because the reflected type of
 * `string | null` is `Object`, which publishes them as `type: object` — wrong
 * for any client generated from the contract, and this route's reader is a
 * frontend outside this repository.
 */
export class PublicPaymentLinkEntity {
  @ApiProperty({
    example: 'cmh4x2k9a0001l70g8v5q3z2w',
    description:
      'The payment intent id. It is also the capability: anyone holding it ' +
      'can read this.',
  })
  id!: string;

  @ApiProperty({
    enum: PaymentIntentKind,
    example: 'PAY',
    description:
      '`PAY`: a link the wallet builds the payment from. `TX`: a Stellar ' +
      'envelope built for one known payer, carried inside `uri`.',
  })
  kind!: PaymentIntentKind;

  @ApiProperty({ enum: CHAINS, example: 'stellar' })
  chain!: Chain;

  @ApiProperty({
    enum: ['public', 'testnet'],
    example: 'public',
    description:
      'Network tier: `public` (mainnet) or `testnet` (Stellar testnet, ' +
      'Solana devnet, Monad testnet).',
  })
  network!: string;

  @ApiProperty({
    enum: PaymentIntentStatus,
    example: 'PENDING',
    description:
      'The stored status. An unpaid intent past `expiresAt` reads `PENDING` ' +
      'until the observer expires it, and `EXPIRED` is not final: a payment ' +
      'verified on-chain later still moves it to `SUCCEEDED`.',
  })
  status!: PaymentIntentStatus;

  @ApiProperty({
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
    description:
      'The address the payer sends to — always the one inside `uri`. ' +
      'Stellar and Solana: the merchant’s account. Monad with a relayer: the ' +
      'intent’s own deposit address, which forwards the payment to the ' +
      'merchant less `networkFee`.',
  })
  payTo!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '25.5',
    description: 'Decimal, in the asset’s units. Null: the payer chooses.',
  })
  amount!: string | null;

  @ApiProperty({
    example: 'native',
    description:
      'Asset code, or `native` for the chain’s coin (XLM, SOL, MON).',
  })
  asset!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'Stellar: the issuer. Solana: the SPL mint. Monad: the ERC-20 ' +
      'contract. Null for the native coin.',
  })
  assetIssuer!: string | null;

  @ApiProperty({
    example: '4127759120438726917',
    description:
      'The intent’s MEMO_ID. On Stellar the payment must carry it, and the ' +
      'link does.',
  })
  memo!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Order #24',
    description: 'The message the merchant attached for the payer.',
  })
  msg!: string | null;

  @ApiProperty({
    example:
      'web+stellar:pay?destination=GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO&amount=25.5&memo=4127759120438726917&memo_type=MEMO_ID&msg=Order+%2324',
    description:
      'The payment link, exactly as the wallet opens it: SEP-7 on Stellar, ' +
      'Solana Pay on Solana, EIP-681 on Monad. It is the same link the ' +
      'merchant handed out, so it carries what the wallet needs — a SEP-7 ' +
      '`callback` the merchant set and, for a `TX` intent, the unsigned ' +
      'envelope.',
  })
  uri!: string;

  @ApiProperty({
    example: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA…',
    description: 'QR code of `uri` (PNG data URL), derived on read.',
  })
  qr!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'The transaction reported or verified for this intent.',
  })
  txHash!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'Deducted before the merchant is paid, in the asset’s units: the ' +
      'relayer’s fee for forwarding a Monad deposit. Null when nothing is.',
  })
  networkFee!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    example: '2026-10-24T13:34:56.000Z',
    description:
      'When an unpaid intent expires. A payment verified later still ' +
      'settles it.',
  })
  expiresAt!: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-10-24T12:34:56.000Z' })
  createdAt!: string;
}
