import { ApiProperty, OmitType } from '@nestjs/swagger';
import { Usdt0TransferStatus } from '@generated/prisma/client';
import { MerchantFeeEntity } from '@/common/merchant-fee/merchant-fee.entity';
import { USDT0_CHAIN_IDS } from '@/usdt0/usdt0.constants';
import { ApiPublicTokenProperty } from '@/common/decorators/api-record-token.decorator';

/** USDT0 on Stellar: the classic asset and its Stellar Asset Contract. */
export class Usdt0TokenEntity {
  @ApiProperty({ example: 'USDT0' })
  code!: string;

  @ApiProperty({
    example: 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q',
  })
  issuer!: string;

  @ApiProperty({
    example: 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF',
    description: "The asset's Stellar Asset Contract (SAC).",
  })
  contract!: string;
}

/** One network USDT0 can be sent to from Stellar. */
export class Usdt0RouteEntity {
  @ApiProperty({
    enum: USDT0_CHAIN_IDS,
    example: 'eth',
    description: 'The id requests name this network with (`to`).',
  })
  chain!: string;

  @ApiProperty({ example: 'Ethereum' })
  name!: string;

  @ApiProperty({ example: 30101, description: 'LayerZero endpoint id.' })
  eid!: number;

  @ApiProperty({
    enum: ['USDT', 'USDT0'],
    example: 'USDT',
    description:
      'What arrives: native `USDT` on Ethereum (Tether’s OFT adapter unlocks ' +
      'it), `USDT0` everywhere else.',
  })
  receives!: string;
}

/** Response of `GET /v1/usdt0/routes`. */
export class Usdt0RoutesEntity {
  @ApiProperty({
    example: 'public',
    description: 'Always `public`: USDT0 exists on Stellar mainnet only.',
  })
  network!: string;

  @ApiProperty({
    example: true,
    description:
      'Whether this API key can send USDT0: true for a prod (mainnet) key. A ' +
      'dev (testnet) key gets `false` and no routes.',
  })
  available!: boolean;

  @ApiProperty({ type: Usdt0TokenEntity })
  token!: Usdt0TokenEntity;

  @ApiProperty({
    example: 'CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6',
    description: 'The LayerZero OFT contract the transaction calls (`send`).',
  })
  oft!: string;

  @ApiProperty({
    example: 30600,
    description: "Stellar mainnet's LayerZero endpoint id.",
  })
  eid!: number;

  @ApiProperty({ type: [Usdt0RouteEntity] })
  routes!: Usdt0RouteEntity[];
}

/** Response of `POST /v1/usdt0/quote`: pricing only, nothing is persisted. */
export class Usdt0QuoteEntity {
  @ApiProperty({ enum: USDT0_CHAIN_IDS, example: 'eth' })
  to!: string;

  @ApiProperty({ example: 30101 })
  eid!: number;

  @ApiProperty({ enum: ['USDT', 'USDT0'], example: 'USDT' })
  receives!: string;

  @ApiProperty({ example: '12.5000001', description: 'The amount asked for.' })
  amount!: string;

  @ApiProperty({
    example: '12.5',
    description:
      'What the OFT takes from the account: `amount` without its dust.',
  })
  amountSent!: string;

  @ApiProperty({
    example: '12.5',
    description:
      'What arrives on the destination network (in its token’s 6 decimals). ' +
      'Equal to `amountSent` unless the OFT charges a fee of its own.',
  })
  amountReceived!: string;

  @ApiProperty({
    example: '0.0000001',
    description:
      'The 7th decimal the OFT cannot carry (it shares 6 across chains). ' +
      'It stays in the account; nothing is lost.',
  })
  dust!: string;

  @ApiProperty({
    example: '3.6664143',
    description:
      'LayerZero’s messaging fee, in XLM, paid by the account on top of the ' +
      'USDT0. It follows LayerZero’s price feeds and changes over time.',
  })
  nativeFee!: string;

  @ApiProperty({
    example: '4.3996972',
    description:
      'What a transfer built now would offer LayerZero, in XLM: `nativeFee` ' +
      'plus a 20% buffer for the minutes before it is signed. What LayerZero ' +
      'does not charge returns to the account in the same transaction, but ' +
      'the account must hold all of it.',
  })
  nativeFeeLimit!: string;

  @ApiProperty({
    example: '0',
    description: 'The smallest amount the OFT accepts, in USDT0.',
  })
  minAmount!: string;

  @ApiProperty({
    example: '1844674407370.9551615',
    description: 'The largest amount the OFT accepts, in USDT0.',
  })
  maxAmount!: string;
}

/** A USDT0 transfer from Stellar (the `usdt0_transfer` row) and its derived fields. */
export class Usdt0TransferEntity {
  @ApiProperty({ example: 'cm2u0t0transfer0000000001' })
  id!: string;

  @ApiProperty({
    enum: Usdt0TransferStatus,
    example: 'PENDING',
    description:
      'PENDING: built, waiting for the signature. SUBMITTED: on the Stellar ' +
      'ledger, LayerZero is delivering it. DELIVERED: credited on the ' +
      'destination network. FAILED: the Stellar transaction failed, or ' +
      'LayerZero gave up on the message (`failureReason`). EXPIRED: never ' +
      'reached the ledger before `expiresAt`. A read refreshes a PENDING or ' +
      'SUBMITTED transfer from the ledger and LayerZero Scan.',
  })
  status!: Usdt0TransferStatus;

  @ApiProperty({ example: 'public', description: 'Always mainnet.' })
  network!: string;

  @ApiProperty({
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  source!: string;

  @ApiProperty({ enum: USDT0_CHAIN_IDS, example: 'eth' })
  to!: string;

  @ApiProperty({ example: 30101 })
  eid!: number;

  @ApiProperty({ enum: ['USDT', 'USDT0'], example: 'USDT' })
  receives!: string;

  @ApiProperty({
    example: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    description: 'The EVM address credited, EIP-55.',
  })
  recipient!: string;

  @ApiProperty({ example: '12.5000001', description: 'The amount asked for.' })
  amount!: string;

  @ApiProperty({
    example: '12.5',
    description:
      'What the OFT takes from the account: `amount` without its dust.',
  })
  amountSent!: string;

  @ApiProperty({
    example: '12.5',
    description:
      'What arrives, and the on-chain floor: the transaction fails rather ' +
      'than deliver less.',
  })
  amountReceived!: string;

  @ApiProperty({
    example: '0.0000001',
    description: 'The dust left in the account (`amount` - `amountSent`).',
  })
  dust!: string;

  @ApiProperty({
    example: '3.6664143',
    description: 'LayerZero’s quoted messaging fee, in XLM.',
  })
  nativeFee!: string;

  @ApiProperty({
    example: '4.3996972',
    description:
      'What the transaction offers LayerZero, in XLM: `nativeFee` plus a 20% ' +
      'buffer. The endpoint charges the real fee and returns the rest to the ' +
      'account in the same transaction.',
  })
  nativeFeeLimit!: string;

  @ApiProperty({
    example: '1.4468825',
    description:
      'The Stellar network fee, in XLM: inclusion plus Soroban resources ' +
      '(part of it is refunded by the network).',
  })
  networkFee!: string;

  @ApiProperty({
    description: 'The unsigned transaction (base64 XDR) to sign.',
    example: 'AAAAAgAAAABx…(base64 XDR)…AAAAAAAAAAA=',
  })
  xdr!: string;

  @ApiProperty({
    example: 'web+stellar:tx?xdr=AAAAAgAAAABx…',
    description: 'A SEP-7 `tx` link carrying `xdr`.',
  })
  uri!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    example: null,
    description:
      'A QR of `uri` as a PNG data URL, or null when the transaction is too ' +
      'large for one, which a Soroban transaction usually is (its ledger ' +
      'footprint makes the XDR several kilobytes). Sign with a connected ' +
      'wallet (Freighter) or the link instead.',
  })
  qr!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: null,
    description:
      'The Stellar transaction hash once it reached the network (SUBMITTED, ' +
      'DELIVERED, FAILED); null while PENDING or EXPIRED.',
  })
  txHash!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: null,
    description:
      'LayerZero’s message id (0x + 64 hex), once the transaction landed.',
  })
  guid!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: null,
    description: 'The destination network’s transaction, once DELIVERED.',
  })
  destinationTxHash!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: null,
    description:
      'LayerZero Scan’s own status word, verbatim (`INFLIGHT`, `CONFIRMING`, ' +
      '`DELIVERED`, `PAYLOAD_STORED`, ...).',
  })
  scanStatus!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: null,
    description:
      'The transaction on LayerZero Scan (layerzeroscan.com), once it reached ' +
      'the network.',
  })
  scanUrl!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: null,
    description: 'Why a FAILED transfer failed.',
  })
  failureReason!: string | null;

  @ApiProperty({
    type: MerchantFeeEntity,
    nullable: true,
    description:
      'The merchant fee the request named, in USDT0, paid to its wallet in ' +
      'this transaction by the merchant fee wrapper; null without one.',
  })
  merchantFee!: MerchantFeeEntity | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: null,
    description: 'The Idempotency-Key it was created with, if any.',
  })
  idempotencyKey!: string | null;

  @ApiProperty({
    example: '2026-10-25T12:05:00.000Z',
    description:
      "When the transaction's time bounds close: submit refuses it afterwards.",
  })
  expiresAt!: Date;

  @ApiProperty({
    nullable: true,
    type: Date,
    example: null,
    description: 'When it was first seen accepted by the network.',
  })
  submittedAt!: Date | null;

  @ApiProperty({ example: '2026-10-25T12:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-10-25T12:00:00.000Z' })
  updatedAt!: Date;
}

/** What `POST /v1/usdt0/transfers` answers: the transfer, and its read token. */
export class Usdt0TransferCreatedEntity extends Usdt0TransferEntity {
  @ApiPublicTokenProperty()
  publicToken?: string;
}

/**
 * A transfer as `GET /v1/usdt0/transfers` lists it: everything but the QR,
 * which the single read renders.
 */
export class Usdt0TransferListItemEntity extends OmitType(Usdt0TransferEntity, [
  'qr',
] as const) {}

export class Usdt0TransferListEntity {
  @ApiProperty({ type: [Usdt0TransferListItemEntity] })
  data!: Usdt0TransferListItemEntity[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}

/** Result of `POST /v1/usdt0/transfers/{id}/submit`. */
export class Usdt0SubmitResultEntity {
  @ApiProperty({
    example: true,
    description:
      'True when the network accepted the transaction (status SUBMITTED, or ' +
      'already DELIVERED).',
  })
  submitted!: boolean;

  @ApiProperty({ enum: Usdt0TransferStatus, example: 'SUBMITTED' })
  status!: Usdt0TransferStatus;

  @ApiProperty({
    required: false,
    example: '6bc5348acd5dfa908c8d8ff8401d5cce5e659566b0f6707a84950b16ca7410e8',
    description: 'The Stellar transaction hash, once it reached the network.',
  })
  txHash?: string;

  @ApiProperty({
    required: false,
    example: null,
    nullable: true,
    description:
      'Why it was not submitted, when `submitted` is false: the network ' +
      'refused it (the transfer stays PENDING and can be submitted again ' +
      'until it expires), or it failed on the ledger (FAILED).',
  })
  reason?: string;

  @ApiProperty({ type: Usdt0TransferEntity })
  transfer!: Usdt0TransferEntity;
}
