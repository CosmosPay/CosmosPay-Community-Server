import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { P2P_DIRECT_BANKS } from '@/native-plugins/eldorado/eldorado.constants';
import {
  PERSON_NAME_RE,
  type DirectAccountInput,
  type DirectBank,
} from '@/native-plugins/eldorado/p2p-direct';

const ID = 'cmh4x2k9a0001l70g8v5q3z2w';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;

// The fields the page shows a specific error for (the email, the codes, the
// phone, the bank account) are only typed and bounded here: the service checks
// their content and answers that field's own code (`invalid_email`,
// `invalid_code`, `invalid_phone`, `invalid_cbu`, ...), never a generic
// `validation_failed`.

@ApiSchema({ description: 'Starts verifying the payer by email.' })
export class DirectLoginDto {
  @ApiProperty({
    example: 'payer@example.com',
    description:
      'The payer’s email: a code is sent there (a new email also opens their account). Never stored by this service. One that is not an email address is `400 invalid_email`.',
  })
  @Transform(trimmed)
  @IsString()
  @MaxLength(512)
  email!: string;
}

@ApiSchema({ description: 'The code the payer received by email.' })
export class DirectLoginVerifyDto {
  @ApiProperty({
    example: '9f1c2e4a-1b2c-4d5e-8f90-123456789abc',
    description: 'The `challenge` the login answered: opaque, sent back as is.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  @Matches(/^[\x21-\x7e]+$/, {
    message: 'challenge must be the value the login answered',
  })
  challenge!: string;

  @ApiProperty({
    example: 'A1B2C3D4',
    description:
      'The code from the email: 8 letters and digits. A wrong, expired or malformed one is `400 invalid_code`.',
  })
  @Transform(trimmed)
  @IsString()
  @MaxLength(256)
  code!: string;
}

@ApiSchema({
  description:
    'The first verification step: where the payer lives and their phone, which receives a code.',
})
export class DirectKycDetailsDto {
  @ApiProperty({
    example: 'Salta',
    description:
      'The city the payer lives in, in Argentina (the country is always Argentina).',
  })
  @Transform(trimmed)
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(PERSON_NAME_RE, { message: 'city must be the name of a city' })
  city!: string;

  @ApiProperty({
    example: '+54 9 387 412-3456',
    description:
      'An Argentine phone: `+54` and the number, or the 10 digits of the area code and number. Spaces, dashes and parentheses are ignored. Anything else is `400 invalid_phone`.',
  })
  @IsString()
  @MaxLength(256)
  phone!: string;
}

@ApiSchema({ description: 'The code the payer received on their phone.' })
export class DirectKycPhoneDto {
  @ApiProperty({
    example: '1234',
    description:
      'The 4-digit code texted to the phone. A wrong or malformed one is `400 invalid_code`.',
  })
  @Transform(trimmed)
  @IsString()
  @MaxLength(256)
  code!: string;
}

/**
 * A bank account in the payer's name, as the contract publishes it. The
 * service reads `account` field by field (`parseDirectAccount`), so each
 * problem answers its own code; this class documents the shape.
 */
@ApiSchema({
  description:
    'A bank account in the payer’s own name, the one they will transfer from. Never stored by this service.',
})
export class DirectAccountDto implements DirectAccountInput {
  @ApiProperty({
    example: 'Juan Pérez',
    description:
      'The account holder: the payer, as their bank names them (3 to 140 characters). Otherwise `400 invalid_account`.',
  })
  holder!: string;

  @ApiProperty({
    example: '0000003100000000000000',
    description:
      'The CVU or CBU: 22 digits whose two check digits verify (spaces, dashes and dots are ignored). Otherwise `400 invalid_cbu`.',
  })
  cbu!: string;

  @ApiProperty({
    enum: ['CUIT', 'CUIL'],
    example: 'CUIL',
    description:
      'Which tax id `document` is. Otherwise `400 invalid_document`.',
  })
  documentType!: 'CUIT' | 'CUIL';

  @ApiProperty({
    example: '20123456786',
    description:
      'The holder’s CUIT or CUIL: 11 digits whose check digit verifies (dashes and dots are ignored). Otherwise `400 invalid_document`.',
  })
  document!: string;

  @ApiProperty({
    enum: P2P_DIRECT_BANKS,
    example: 'mercado_pago',
    description:
      'The bank or wallet that holds the account. Otherwise `400 invalid_bank`.',
  })
  bank!: DirectBank;

  @ApiProperty({
    enum: ['savings', 'checking'],
    example: 'savings',
    description: 'The kind of account. Otherwise `400 invalid_account`.',
  })
  accountType!: 'savings' | 'checking';
}

@ApiSchema({
  description:
    'Starts a payment: from one of the payer’s saved accounts (`accountId`), or from a new one (`account`). Exactly one of the two, else `400 invalid_account`.',
})
export class CreateDirectOrderDto {
  @ApiPropertyOptional({
    example: '3b1f8a2c-6d4e-4f7a-9c0b-1e2d3f4a5b6c',
    description: 'An `id` from `GET .../direct/accounts`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  accountId?: string;

  @ApiPropertyOptional({ type: DirectAccountDto })
  @IsOptional()
  @IsObject()
  account?: Record<string, unknown>;
}

export class P2pDirectOrderParamsDto {
  @ApiProperty({
    example: ID,
    description: 'Cosmos Pay id of the payment request.',
  })
  @IsString()
  @MaxLength(64)
  id!: string;

  @ApiProperty({
    example: '0b8f4c6e-2a71-4c1e-9d3b-5f7a8e9c1d20',
    description: 'The order’s `id`, as the order routes answered it.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,128}$/, {
    message: 'orderId must be an order id',
  })
  orderId!: string;
}
