import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import {
  DIRECT_KYC_ERRORS,
  DIRECT_KYC_STEPS,
  DIRECT_ORDER_STATUSES,
} from '@/native-plugins/eldorado/p2p-direct';

@ApiSchema({
  description:
    'A verification code was emailed to the payer: send it back with this challenge.',
})
export class DirectLoginEntity {
  @ApiProperty({
    example: '9f1c2e4a-1b2c-4d5e-8f90-123456789abc',
    description:
      'Opaque: send it back with the emailed code to `POST .../direct/login/verify`.',
  })
  challenge!: string;

  @ApiProperty({
    example: false,
    description:
      'Whether the email is new: verifying it also opens the payer’s account.',
  })
  newAccount!: boolean;
}

@ApiSchema({
  description:
    'The payer is verified by email: their session for this payment request.',
})
export class DirectSessionEntity {
  @ApiProperty({
    example: 'v1.Yp3h0Qx2...kq8',
    description:
      'Opaque: send it in `X-Payer-Session` on every other `.../direct/*` route of this payment request. It works for this request only and until `expiresAt`; keep it in the tab (session storage) and drop it once the request is paid.',
  })
  session!: string;

  @ApiProperty({
    example: '2026-11-13T14:00:00.000Z',
    description:
      'When the session stops working (at most two hours): the payer verifies their email again.',
  })
  expiresAt!: string;
}

@ApiSchema({
  description:
    'Where the payer stands in verifying their identity, and what the page asks next.',
})
export class DirectKycEntity {
  @ApiProperty({
    enum: DIRECT_KYC_STEPS,
    example: 'document',
    description:
      '`details`: ask the city and phone (`POST .../direct/kyc/details`). `phone`: ask the code texted to the phone (`POST .../direct/kyc/phone`). `document`: open `documentUrl` in a new tab to verify an ID document, then read this again. `review`: the document is being reviewed. `rejected`: the verification was refused. `ready`: the payer can pay.',
  })
  step!: string;

  @ApiProperty({
    example: 'https://verify.example/session/abc',
    type: String,
    nullable: true,
    description:
      'At `document`: the page where the payer verifies their ID document. Null at every other step.',
  })
  documentUrl!: string | null;

  @ApiProperty({
    enum: DIRECT_KYC_ERRORS,
    example: null,
    type: String,
    nullable: true,
    description:
      'At `details`, why the phone must be given again: `phone_taken` (another account has it) or `phone_invalid`. Null otherwise.',
  })
  error!: string | null;

  @ApiProperty({
    example: '9850.00',
    type: String,
    nullable: true,
    description:
      'At `ready`: what the payer may still pay this month, in USD. Null when it cannot be read, and at every other step.',
  })
  limitUsd!: string | null;
}

@ApiSchema({
  description: 'One of the payer’s saved bank accounts. Never its full number.',
})
export class DirectAccountEntity {
  @ApiProperty({
    example: '3b1f8a2c-6d4e-4f7a-9c0b-1e2d3f4a5b6c',
    description: 'Send it as `accountId` to `POST .../direct/orders`.',
  })
  id!: string;

  @ApiProperty({ example: 'Juan Pérez', description: 'The account holder.' })
  holder!: string;

  @ApiProperty({
    example: 'mercado_pago',
    type: String,
    nullable: true,
    description: 'The bank or wallet, as `account.bank` names it.',
  })
  bank!: string | null;

  @ApiProperty({
    example: '0000',
    type: String,
    nullable: true,
    description:
      'Enough to recognise it: the alias of an alias account, else the last four digits of the CVU/CBU.',
  })
  hint!: string | null;
}

@ApiSchema({
  description: 'The payer’s saved bank accounts in their own name.',
})
export class DirectAccountsEntity {
  @ApiProperty({
    type: [DirectAccountEntity],
    description: 'Empty for a payer with none: ask for a new one.',
  })
  accounts!: DirectAccountEntity[];
}

@ApiSchema({
  description:
    'Where to transfer: the account of the verified seller who took the payment.',
})
export class DirectPayToEntity {
  @ApiProperty({
    example: 'María Gómez',
    description: 'Who receives the transfer.',
  })
  holder!: string;

  @ApiProperty({
    example: '0000003100000000000000',
    type: String,
    nullable: true,
    description:
      'The CVU/CBU to transfer to (22 digits), when the seller gave one.',
  })
  cbu!: string | null;

  @ApiProperty({
    example: 'maria.gomez.mp',
    type: String,
    nullable: true,
    description: 'The alias to transfer to, when the seller gave one.',
  })
  alias!: string | null;

  @ApiProperty({
    example: 'mercado_pago',
    type: String,
    nullable: true,
    description: 'The seller’s bank or wallet.',
  })
  bank!: string | null;
}

@ApiSchema({
  description:
    'A payment to a verified seller, as the payer’s page follows it.',
})
export class DirectOrderEntity {
  @ApiProperty({
    example: '0b8f4c6e-2a71-4c1e-9d3b-5f7a8e9c1d20',
    description: 'The order’s id, for `.../direct/orders/{orderId}`.',
  })
  id!: string;

  @ApiProperty({
    enum: DIRECT_ORDER_STATUSES,
    example: 'pay',
    description:
      '`matching`: looking for a seller (poll it). `pay`: transfer exactly `amount` to `payTo` before `dueAt`, then mark it paid. `confirming`: the payer transferred and the seller is confirming it; `dueAt` is when the payer may ask for help. `completed`: paid. `cancelled`: nobody took it, it ran out of time or it was cancelled: start again. `disputed`: under review.',
  })
  status!: string;

  @ApiProperty({
    example: '15000',
    description: 'The exact amount to transfer, a decimal string.',
  })
  amount!: string;

  @ApiProperty({ example: 'ARS', description: 'The currency of `amount`.' })
  currency!: string;

  @ApiProperty({
    type: DirectPayToEntity,
    nullable: true,
    description:
      'At `pay` and `confirming`: where to transfer. Null otherwise.',
  })
  payTo!: DirectPayToEntity | null;

  @ApiProperty({
    example: '2026-11-13T13:00:00.000Z',
    type: String,
    nullable: true,
    description:
      'At `pay`: the deadline for the transfer, after which the order is cancelled. At `confirming`: from when the payer may ask for help. Null otherwise.',
  })
  dueAt!: string | null;

  @ApiProperty({
    example: '2026-11-13T12:30:00.000Z',
    description: 'When the order was opened.',
  })
  createdAt!: string;
}
