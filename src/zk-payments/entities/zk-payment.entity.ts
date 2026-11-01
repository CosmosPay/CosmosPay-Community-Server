import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { ZkPaymentStatus } from '@generated/prisma/client';
import { MerchantFeeEntity } from '@/common/merchant-fee/merchant-fee.entity';

const TOKEN = 'CBQU5SGVPPYI5MVBVV5GYTYNHENHBY7J44WYYVDPTZ5UNK6JDEY232QX';
const RECIPIENT = 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO';
const FEE_ACCOUNT = 'GDUYXOQZFVPDVIVBTJNUCGYQEC3XSI2LQOQ3SJWJJ6ZY4JLCJZZFGTNQ';

/** Cosmos Pay's confidential token on one network: what a wallet needs to use it. */
@ApiSchema({
  description:
    "Cosmos Pay's confidential token on one network, the token private " +
    'payments are made on: what a wallet needs to use it.',
})
export class ZkTokenEntity {
  @ApiProperty({
    example: TOKEN,
    description: 'The confidential token contract (C...).',
  })
  contractId!: string;

  @ApiProperty({ example: 'XLM', description: 'What it wraps: native XLM.' })
  symbol!: string;

  @ApiProperty({
    example: 7,
    description: "Decimal places of the token's amounts (7, as for XLM).",
  })
  decimals!: number;

  @ApiProperty({
    example: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    description: "Native XLM's Stellar Asset Contract on this network.",
  })
  underlying!: string;

  @ApiProperty({
    example: 5387137,
    description:
      'The ledger the token was deployed at: where a wallet replays its ' +
      'confidential balance from.',
  })
  deployedAtLedger!: number;
}

/** `GET /v1/zk-payments/config`: the caller's network, as the dashboard sets up. */
@ApiSchema({
  description:
    "A network's private payments setup: the token, registries, auditor id, " +
    'commission and fee account a wallet registers, proves and pays against. ' +
    'Everything in it is public on-chain data or a public URL.',
})
export class ZkPaymentsConfigEntity {
  @ApiProperty({
    example: true,
    description:
      'Whether private payments run on this network. False until the operator ' +
      'deploys the token there (mainnet today); every other field but ' +
      '`network`, `networkPassphrase`, `auditorId` and `feeBps` is then null.',
  })
  enabled!: boolean;

  @ApiProperty({
    enum: ['public', 'testnet'],
    example: 'testnet',
    description: "The network the API key's environment selects.",
  })
  network!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://soroban-testnet.stellar.org',
    description: 'The Soroban RPC to build and submit transactions through.',
  })
  rpcUrl!: string | null;

  @ApiProperty({
    example: 'Test SDF Network ; September 2015',
    description: 'The Stellar network passphrase of `network`.',
  })
  networkPassphrase!: string;

  @ApiProperty({
    type: ZkTokenEntity,
    nullable: true,
    description:
      "Cosmos Pay's confidential token on this network; null when `enabled` is false.",
  })
  token!: ZkTokenEntity | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'CAN45PFA5CVUCU3JB77IE2JNWNTRCDWMRNG55U452L3N2IOCAGOLTUVQ',
    description:
      'The UltraHonk verifier registry the token checks proofs with.',
  })
  verifier!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'CDKWSGQER4KNDTMZS2W7V4E32KSL7BVM3LBY7EBTPWZZ3SFG5CDAOLF2',
    description: "The auditor registry holding Cosmos Pay's key.",
  })
  auditorRegistry!: string | null;

  @ApiProperty({
    example: 0,
    description: 'The auditor id every account on the token registers under.',
  })
  auditorId!: number;

  @ApiProperty({ example: 18, description: 'The commission: 18 bps = 0.18%.' })
  feeBps!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: FEE_ACCOUNT,
    description: "Cosmos Pay's account the commission is transferred to.",
  })
  feeAccount!: string | null;
}

/** A private payment as its owner reads it. */
@ApiSchema({
  description:
    "A private payment as its owner (the merchant's API key) reads it: the " +
    'amounts, the accounts to pay, the status and the transactions that settled it.',
})
export class ZkPaymentEntity {
  @ApiProperty({
    example: 'cmh4x2k9a0001l70g8v5q3z2w',
    description: 'The private payment id (a cuid).',
  })
  id!: string;

  @ApiProperty({
    enum: ZkPaymentStatus,
    example: 'PENDING',
    description:
      'As it reads now: a PENDING payment past `expiresAt` reads EXPIRED. It ' +
      'can still settle: transfers that closed before `expiresAt` paid it.',
  })
  status!: ZkPaymentStatus;

  @ApiProperty({
    enum: ['public', 'testnet'],
    example: 'testnet',
    description:
      'The network the payment is on, set by the API key that created it.',
  })
  network!: string;

  @ApiProperty({
    example: TOKEN,
    description: 'The confidential token both transfers must be made on.',
  })
  tokenContract!: string;

  @ApiProperty({
    example: '25.5',
    description:
      'What the payer pays in total, in XLM: `netAmount + feeAmount`, plus ' +
      '`merchantFee.amount` when there is one.',
  })
  amount!: string;

  @ApiProperty({
    example: '25.49745',
    description:
      'What the merchant receives: `amount - feeAmount`, less ' +
      '`merchantFee.amount` when there is one.',
  })
  netAmount!: string;

  @ApiProperty({
    example: '0.00255',
    description:
      'The commission: `ceil(amount * feeBps / 10000)` in stroops, at least one.',
  })
  feeAmount!: string;

  @ApiProperty({
    example: 1,
    description:
      'The commission rate the payment was priced at, in basis points (1 = 0.01%).',
  })
  feeBps!: number;

  @ApiProperty({ example: RECIPIENT, description: 'The merchant (G...).' })
  recipient!: string;

  @ApiProperty({
    example: FEE_ACCOUNT,
    description:
      "Cosmos Pay's account the commission (`feeAmount`) is paid to.",
  })
  feeAccount!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'The account both transfers came from, once settled.',
  })
  payer!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'The transaction of the transfer that paid `netAmount` to the recipient ' +
      '(64 lowercase hex), once settled.',
  })
  paymentTxHash!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'The transaction of the transfer that paid `feeAmount` to the fee account ' +
      '(64 lowercase hex), once settled.',
  })
  feeTxHash!: string | null;

  @ApiProperty({
    type: MerchantFeeEntity,
    nullable: true,
    description:
      'The merchant fee the request named, paid by a third confidential ' +
      'transfer to its wallet; null without one.',
  })
  merchantFee!: MerchantFeeEntity | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: "The merchant fee's transaction, once settled.",
  })
  merchantFeeTxHash!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Order #24',
    description:
      'The description given at create, shown to the payer by the checkout; ' +
      'null when none was given.',
  })
  description!: string | null;

  @ApiProperty({
    example: 'order-24',
    description:
      'The idempotency key of the create: the one sent (header first, then ' +
      'body), or a generated `zkp_...` key when none was.',
  })
  idempotencyKey!: string;

  @ApiProperty({
    example: '2026-10-25T15:00:00.000Z',
    description:
      'When the payment stops being payable (ISO 8601 date-time). Every ' +
      'transfer must close before it.',
  })
  expiresAt!: Date;

  @ApiProperty({
    type: Date,
    nullable: true,
    example: null,
    description: 'When the later of the two transfers closed, once settled.',
  })
  settledAt!: Date | null;

  @ApiProperty({
    example: '2026-10-25T14:00:00.000Z',
    description:
      'When the payment was created (ISO 8601 date-time). A transfer that ' +
      'closed more than a minute before it cannot pay it.',
  })
  createdAt!: Date;

  @ApiProperty({
    example: '2026-10-25T14:00:00.000Z',
    description: 'When the payment was last changed (ISO 8601 date-time).',
  })
  updatedAt!: Date;
}

@ApiSchema({
  description:
    "One page of the API key's private payments on its network, newest first.",
})
export class ZkPaymentListEntity {
  @ApiProperty({
    type: [ZkPaymentEntity],
    description: 'The private payments on this page, newest first.',
  })
  data!: ZkPaymentEntity[];

  @ApiProperty({
    example: 1,
    description: 'How many private payments match the query, across all pages.',
  })
  total!: number;

  @ApiProperty({
    example: 20,
    description: 'The page size this page was read with.',
  })
  take!: number;

  @ApiProperty({
    example: 0,
    description: 'How many matching payments were skipped before this page.',
  })
  skip!: number;
}

/**
 * A private payment as its payer's checkout reads it: what to pay, to whom, on which
 * contracts. Never the owner's data: no consumer, no idempotency key, no
 * transaction hashes.
 */
@ApiSchema({
  description:
    "A private payment as its payer's checkout reads it, with no API key: what " +
    'to pay, to whom and on which contracts, and the live status to poll. ' +
    'Never the owning merchant account, the idempotency key or the transaction hashes.',
})
export class PublicZkPaymentEntity {
  @ApiProperty({
    example: 'cmh4x2k9a0001l70g8v5q3z2w',
    description: 'The private payment id (a cuid).',
  })
  id!: string;

  @ApiProperty({
    enum: ZkPaymentStatus,
    example: 'PENDING',
    description:
      'As it reads now: a PENDING payment past `expiresAt` reads EXPIRED, and ' +
      'can still settle with transfers that closed before `expiresAt`.',
  })
  status!: ZkPaymentStatus;

  @ApiProperty({
    example: '25.5',
    description:
      'What the payer pays in total, in XLM (decimal string): `netAmount + ' +
      'feeAmount`, plus `merchantFee.amount` when there is one.',
  })
  amount!: string;

  @ApiProperty({
    example: '25.49745',
    description:
      'What the merchant receives, in XLM (decimal string): the amount of the ' +
      'transfer to `recipient`.',
  })
  netAmount!: string;

  @ApiProperty({
    example: '0.00255',
    description:
      "Cosmos Pay's commission, in XLM (decimal string): the amount of the " +
      'transfer to `feeAccount`.',
  })
  feeAmount!: string;

  @ApiProperty({
    example: 1,
    description:
      'The commission rate the payment was priced at, in basis points (1 = 0.01%).',
  })
  feeBps!: number;

  @ApiProperty({
    example: RECIPIENT,
    description: 'Transfer `netAmount` here.',
  })
  recipient!: string;

  @ApiProperty({
    example: FEE_ACCOUNT,
    description: 'Transfer `feeAmount` here, from the same account.',
  })
  feeAccount!: string;

  @ApiProperty({
    type: MerchantFeeEntity,
    nullable: true,
    description:
      'When not null, a third transfer: `merchantFee.amount` to ' +
      '`merchantFee.wallet`, from the same account.',
  })
  merchantFee!: MerchantFeeEntity | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Order #24',
    description:
      "The merchant's description of the payment, to show the payer; null " +
      'when none was given.',
  })
  description!: string | null;

  @ApiProperty({
    example: '2026-10-25T15:00:00.000Z',
    description:
      'When the payment stops being payable (ISO 8601 date-time). Every ' +
      'transfer must close before it.',
  })
  expiresAt!: Date;

  @ApiProperty({
    enum: ['public', 'testnet'],
    example: 'testnet',
    description:
      'The network the payment is on, and the transfers must be made on.',
  })
  network!: string;

  @ApiProperty({
    example: 'https://soroban-testnet.stellar.org',
    description: 'The Soroban RPC to build and submit the transfers through.',
  })
  rpcUrl!: string;

  @ApiProperty({
    example: 'Test SDF Network ; September 2015',
    description: 'The Stellar network passphrase of `network`.',
  })
  networkPassphrase!: string;

  @ApiProperty({
    type: ZkTokenEntity,
    description: 'The confidential token the transfers are made on.',
  })
  token!: ZkTokenEntity;

  @ApiProperty({
    example: 0,
    description:
      'The auditor id the transfers are encrypted to: Cosmos Pay reads the ' +
      'amount with it to confirm the payment.',
  })
  auditorId!: number;
}
