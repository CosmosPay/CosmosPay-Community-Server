import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { ApiPublicTokenProperty } from '@/common/decorators/api-record-token.decorator';
import { P2P_PAYMENT_REQUEST_STATUSES } from '@/native-plugins/eldorado/p2p-payment-request';
import { P2pPaymentMethodEntity } from '@/native-plugins/eldorado/entities/p2p-ramp.entity';
import { PAYMENT_REQUEST_METHODS } from '@/payment-request-rails/payment-request-rails';

const ID = 'cmh4x2k9a0001l70g8v5q3z2w';

@ApiSchema({
  description:
    'A charge in local money shown as a QR, as its seller reads it: the amount, the token and address it is delivered to, the link and QR to show, and whether it was paid.',
})
export class P2pPaymentRequestEntity {
  @ApiProperty({ example: ID, description: 'Cosmos Pay id of the request.' })
  id!: string;

  @ApiProperty({
    example: 'public',
    description: '`public` (mainnet) or `testnet` (the sandbox), from the key.',
  })
  network!: string;

  @ApiProperty({
    example: 'open',
    enum: P2P_PAYMENT_REQUEST_STATUSES,
    description:
      '`open` until it is paid (`paid`), cancelled (`cancelled`) or past `expiresAt` (`expired`). `processing` once a bank transfer for it arrived and the token is on its way to `address`: it never reads as expired and cannot be cancelled. An expired or cancelled request still turns `paid` when a payment already under way completes.',
  })
  status!: string;

  @ApiProperty({
    example: 'ARS',
    description: 'Local currency the payer pays in.',
  })
  currency!: string;

  @ApiProperty({
    example: '15000',
    description: 'What the payer pays, in local money, a decimal string.',
  })
  amount!: string;

  @ApiProperty({
    example: 42161,
    description: 'EIP-155 id of the chain the token is delivered on.',
  })
  chainId!: number;

  @ApiProperty({ example: 'USDT0', description: 'Symbol of the token.' })
  token!: string;

  @ApiProperty({
    example: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    description:
      'Its contract on `chainId` (EIP-55); the zero address is the chain’s own coin.',
  })
  tokenAddress!: string;

  @ApiProperty({ example: 6, description: 'Decimals of the token contract.' })
  tokenDecimals!: number;

  @ApiProperty({
    example: '0x52908400098527886E0F7030069857D2E4169EE7',
    description:
      'Where the token is delivered (EIP-55): fixed in every purchase a payer opens for this request. Never shown to the payer.',
  })
  address!: string;

  @ApiProperty({
    example: 'Table 4',
    type: String,
    nullable: true,
    description: 'Shown to the payer under the amount.',
  })
  description!: string | null;

  @ApiProperty({
    example: '8.94',
    type: String,
    nullable: true,
    description:
      'About the token the amount bought at the market price when the request was created, rounded down; null for a token with no USD price. The payer is quoted the firm figure, fees included, before paying.',
  })
  estimatedAmountOut!: string | null;

  @ApiProperty({
    example: ['transfer', 'p2p'],
    enum: PAYMENT_REQUEST_METHODS,
    isArray: true,
    description:
      'How the payer can pay it right now, in the order the page offers them: `transfer` (a bank transfer from an account in the payer’s own name; ARS only) and `p2p` (other payment methods, in a hosted window). Decided when the request is created and checked again on every read.',
  })
  methods!: string[];

  @ApiProperty({
    example: `https://payments.cosmospay.lat/fiat/${ID}`,
    description:
      'The payer’s page: show it, or its QR. The payer picks how to pay there and pays in a hosted window.',
  })
  url!: string;

  @ApiProperty({
    example: 'data:image/png;base64,iVBORw0KGgo...',
    description: 'A QR code of `url`, as a PNG data URL.',
  })
  qr!: string;

  @ApiProperty({
    example: '2026-11-13T12:00:00.000Z',
    description: 'When it stops being payable.',
  })
  expiresAt!: string;

  @ApiProperty({
    example: '2026-11-12T12:00:00.000Z',
    description: 'When it was created.',
  })
  createdAt!: string;

  @ApiProperty({
    example: null,
    type: String,
    nullable: true,
    description:
      'When this service learned a payment completed it; null until then.',
  })
  paidAt!: string | null;

  @ApiProperty({
    example: null,
    type: String,
    nullable: true,
    description:
      'The token delivered by the payment that paid it, a decimal string; null until paid.',
  })
  paidAmount!: string | null;

  @ApiProperty({
    example: null,
    type: String,
    nullable: true,
    description:
      'The transaction that delivered it on `chainId`; null until paid (or when the payment reported none).',
  })
  paidTxHash!: string | null;

  @ApiProperty({
    example: null,
    type: String,
    nullable: true,
    enum: PAYMENT_REQUEST_METHODS,
    description:
      'How it was paid: `transfer` (a bank transfer) or `p2p` (another payment method); null until paid.',
  })
  paidMethod!: string | null;
}

/** What creating a payment request answers: the request and, for the shared public key, its read token. */
@ApiSchema({
  description:
    'What creating a payment request answers: the request and, for the shared public key, its read token.',
})
export class P2pPaymentRequestCreatedEntity extends P2pPaymentRequestEntity {
  @ApiPublicTokenProperty()
  publicToken?: string;
}

@ApiSchema({ description: 'A page of payment requests, newest first.' })
export class P2pPaymentRequestListEntity {
  @ApiProperty({
    type: [P2pPaymentRequestEntity],
    description: 'The requests on this page.',
  })
  data!: P2pPaymentRequestEntity[];

  @ApiProperty({
    description: 'Matching rows, not the page length.',
    example: 1,
  })
  total!: number;

  @ApiProperty({
    example: 100,
    description:
      'The page size applied, from the `take` query parameter (default 100).',
  })
  take!: number;

  @ApiProperty({
    example: 0,
    description:
      'Rows skipped before this page, from the `skip` query parameter (default 0).',
  })
  skip!: number;
}

@ApiSchema({
  description:
    'A charge in local money as its payer sees it, read without an API key: the amount, the token the seller receives and how it can be paid. Never who is paid.',
})
export class PublicP2pPaymentRequestEntity {
  @ApiProperty({ example: ID, description: 'Cosmos Pay id of the request.' })
  id!: string;

  @ApiProperty({
    example: 'public',
    description:
      '`public` (mainnet) or `testnet` (the sandbox): where the purchase runs.',
  })
  network!: string;

  @ApiProperty({
    example: 'open',
    enum: P2P_PAYMENT_REQUEST_STATUSES,
    description:
      '`open` while it can be paid; `processing` once a bank transfer arrived and the token is on its way to the seller; `paid`, `expired` or `cancelled` once it cannot be paid. Poll it while the payer waits.',
  })
  status!: string;

  @ApiProperty({ example: 'ARS', description: 'Local currency to pay in.' })
  currency!: string;

  @ApiProperty({
    example: '15000',
    description: 'What to pay, in local money, a decimal string.',
  })
  amount!: string;

  @ApiProperty({
    example: 'Table 4',
    type: String,
    nullable: true,
    description: 'The seller’s description.',
  })
  description!: string | null;

  @ApiProperty({
    example: 42161,
    description: 'EIP-155 id of the chain the seller receives on.',
  })
  chainId!: number;

  @ApiProperty({
    example: 'USDT0',
    description: 'Symbol of the token the seller receives.',
  })
  token!: string;

  @ApiProperty({
    example: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    description: 'Its contract on `chainId` (EIP-55).',
  })
  tokenAddress!: string;

  @ApiProperty({
    example: '8.91',
    type: String,
    nullable: true,
    description:
      'About the token the seller receives at the market price right now, rounded down; null when the market cannot be read or the token has no USD price.',
  })
  estimatedAmountOut!: string | null;

  @ApiProperty({
    type: [P2pPaymentMethodEntity],
    description:
      'The local methods the hosted window (`p2p`) can take right now; empty when the market cannot be read.',
  })
  paymentMethods!: P2pPaymentMethodEntity[];

  @ApiProperty({
    example: ['transfer', 'p2p'],
    enum: PAYMENT_REQUEST_METHODS,
    isArray: true,
    description:
      'How it can be paid right now, in the order to offer them: `transfer` (`POST /v1/payment-links/fiat/{id}/transfers` answers the bank transfer instructions) and `p2p` (`POST /v1/payment-links/fiat/{id}/sessions` opens the hosted window). Empty when nothing can pay it now.',
  })
  methods!: string[];

  @ApiProperty({
    example: '2026-11-13T12:00:00.000Z',
    description: 'When it stops being payable.',
  })
  expiresAt!: string;

  @ApiProperty({
    example: '2026-11-12T12:00:00.000Z',
    description: 'When it was created.',
  })
  createdAt!: string;

  @ApiProperty({
    example: null,
    type: String,
    nullable: true,
    description: 'When it was paid; null until then.',
  })
  paidAt!: string | null;
}

@ApiSchema({
  description:
    'A purchase opened to pay a request: the hosted window that takes the payment.',
})
export class P2pPaymentRequestSessionEntity {
  @ApiProperty({
    example:
      'https://p2p-widget.example/exchange?operation=BUY&token=0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9&chain=42161&currency=ARS&paymentMethod=bank_tx_ar&amount=15000',
    description:
      'Open it in a browser tab or window (not an iframe): the payer signs in, verifies their identity and pays a P2P seller there, and the token is delivered to the request’s seller.',
  })
  widgetUrl!: string;

  @ApiProperty({
    example: 'cp-6f1c0e1a-1b2c-4d5e-8f90-123456789abc',
    description: 'The reference of this purchase.',
  })
  reference!: string;
}
