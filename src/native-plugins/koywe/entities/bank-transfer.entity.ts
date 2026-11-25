import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { BANK_TRANSFER_STATUSES } from '@/native-plugins/koywe/bank-transfer';
import {
  TRANSFER_ACCOUNT_STATUSES,
  TRANSFER_ACCOUNT_TYPES,
} from '@/native-plugins/koywe/koywe.constants';

@ApiSchema({
  description:
    'How to pay a charge by bank transfer: the exact amount, the account to transfer it to and until when. Transfer from an account in your own name; the transfer is detected on its own.',
})
export class BankTransferEntity {
  @ApiProperty({
    example: 'cmh9q1w2e0003l70gq7a1b2c3',
    description: 'Cosmos Pay id of this transfer.',
  })
  id!: string;

  @ApiProperty({
    example: 'awaiting_deposit',
    enum: BANK_TRANSFER_STATUSES,
    description:
      '`awaiting_deposit` until the money arrives (`expired` past `expiresAt`), then `converting` while it becomes the seller’s token, `completed` once delivered, `failed` if the conversion was refused (the money is then refunded by hand). The charge itself reads `processing` and then `paid`.',
  })
  status!: string;

  @ApiProperty({ example: 'ARS', description: 'The currency to transfer.' })
  currency!: string;

  @ApiProperty({
    example: '15000',
    description:
      'The exact amount to transfer, a decimal string: the charge’s amount, or a few cents more when the same payer has another open charge of that amount with the same seller (so each transfer is told apart). Transfer exactly this.',
  })
  amount!: string;

  @ApiProperty({
    example: 'cosmospay.qr',
    description: 'The alias of the account to transfer to.',
  })
  alias!: string;

  @ApiProperty({
    example: '0000003100000000000000',
    description: 'The CVU of the same account (22 digits).',
  })
  cvu!: string;

  @ApiProperty({
    example: 'Cosmos Pay',
    type: String,
    nullable: true,
    description:
      'Whose name the account is in: the seller’s; null when it is not known.',
  })
  holder!: string | null;

  @ApiProperty({
    example: null,
    type: String,
    nullable: true,
    description:
      'The bank or wallet that holds the account; null when not known.',
  })
  bank!: string | null;

  @ApiProperty({
    example: '…786',
    description:
      'The last three digits of the document given, to show back. The document itself is never returned or kept.',
  })
  documentHint!: string;

  @ApiProperty({
    example: '2026-11-12T13:00:00.000Z',
    description:
      'Until when to transfer: an hour after asking, never past the charge’s own expiry. Asking again with the same document answers the same transfer.',
  })
  expiresAt!: string;
}

@ApiSchema({
  description:
    'Your bank transfer account: where payers of your charges transfer pesos, opened in your name once a verification you complete on a hosted form approves it.',
})
export class TransferAccountEntity {
  @ApiProperty({
    example: 'pending',
    enum: TRANSFER_ACCOUNT_STATUSES,
    description:
      '`none` (no account yet), `pending` (finish the verification at `verificationUrl`), `in_review`, `approved` (charges can be paid by bank transfer to `alias` / `cvu`) or `rejected` (see `reason`; open it again).',
  })
  status!: string;

  @ApiProperty({
    example: 'person',
    enum: TRANSFER_ACCOUNT_TYPES,
    type: String,
    nullable: true,
    description: '`person` or `company`; null with no account.',
  })
  type!: string | null;

  @ApiProperty({
    example: 'Juan Pérez',
    type: String,
    nullable: true,
    description: 'The name the account is in; null with no account.',
  })
  name!: string | null;

  @ApiProperty({
    example: 'https://verify.example/form/abc',
    type: String,
    nullable: true,
    description:
      'The hosted verification form to complete, while `pending` or `in_review`; null otherwise or while it is being prepared (read again in a few seconds).',
  })
  verificationUrl!: string | null;

  @ApiProperty({
    example: null,
    type: String,
    nullable: true,
    description: 'Why it was rejected; null unless `rejected`.',
  })
  reason!: string | null;

  @ApiProperty({
    example: null,
    type: String,
    nullable: true,
    description: 'The alias payers transfer to, once `approved`.',
  })
  alias!: string | null;

  @ApiProperty({
    example: null,
    type: String,
    nullable: true,
    description: 'The CVU payers transfer to (22 digits), once `approved`.',
  })
  cvu!: string | null;

  @ApiProperty({
    example: null,
    type: String,
    nullable: true,
    description:
      'The bank or wallet that holds it, once `approved`, when known.',
  })
  bank!: string | null;

  @ApiProperty({
    example: '2026-11-12T12:00:00.000Z',
    type: String,
    nullable: true,
    description: 'When it last changed; null with no account.',
  })
  updatedAt!: string | null;
}
