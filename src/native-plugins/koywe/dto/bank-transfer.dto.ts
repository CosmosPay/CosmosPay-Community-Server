import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  TRANSFER_ACCOUNT_TYPES,
  type TransferAccountType,
} from '@/native-plugins/koywe/koywe.constants';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * One line a person typed: no control character, no line or paragraph
 * separator, no bidirectional mark, override or isolate.
 */
const SINGLE_LINE_RE =
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  /^[^\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]*$/;

/** What the payer types to get deposit instructions. */
@ApiSchema({
  description:
    'The payer’s Argentine CUIT/CUIL or DNI: it identifies their transfer, which must come from an account in their own name.',
})
export class CreateBankTransferDto {
  @ApiProperty({
    example: '20-12345678-6',
    description:
      'A CUIT/CUIL (11 digits whose check digit verifies) or a DNI (7 or 8 digits), with or without dashes, dots or spaces. Only an HMAC of its DNI part and its last three digits are kept.',
  })
  @IsString()
  @MaxLength(32)
  document!: string;
}

export class BankTransferParamsDto {
  @ApiProperty({
    example: 'cmh4x2k9a0001l70g8v5q3z2w',
    description: 'Cosmos Pay id of the payment request.',
  })
  @IsString()
  @MaxLength(64)
  id!: string;
}

/** What a seller sends to open their bank transfer account. */
@ApiSchema({
  description:
    'Who the bank transfer account is for: the seller, a person or a company, whose ARS account payers transfer to. Sent to the verification partner; only the name, the type and three digits of the tax id are kept.',
})
export class CreateTransferAccountDto {
  @ApiProperty({
    example: 'person',
    enum: TRANSFER_ACCOUNT_TYPES,
    description: '`person` or `company`.',
  })
  @IsIn([...TRANSFER_ACCOUNT_TYPES])
  type!: TransferAccountType;

  @ApiProperty({
    example: 'Juan Pérez',
    description:
      'The full legal name (a company’s registered name): the account is opened in it, and payers see it as the holder.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(SINGLE_LINE_RE, { message: 'name must be one line' })
  name!: string;

  @ApiProperty({
    example: '20-12345678-6',
    description:
      'The CUIT/CUIL (11 digits whose check digit verifies; dashes, dots and spaces allowed). A company gives its CUIT (starting 30, 33 or 34).',
  })
  @IsString()
  @MaxLength(32)
  taxId!: string;

  @ApiProperty({
    example: 'juan@example.com',
    description:
      'Where the verification form and the account’s notices are sent.',
  })
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiPropertyOptional({
    example: '+5493875551234',
    description: 'A phone number in international format.',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(/^\+?[0-9 ()-]{6,24}$/, {
    message: 'phone must be a phone number',
  })
  phone?: string;

  @ApiProperty({
    example: 'Av. Belgrano 123',
    description: 'The street address.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  @Matches(SINGLE_LINE_RE, { message: 'address must be one line' })
  address!: string;

  @ApiPropertyOptional({ example: 'Salta', description: 'The city.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  @Matches(SINGLE_LINE_RE, { message: 'city must be one line' })
  city?: string;

  @ApiPropertyOptional({ example: '4400', description: 'The postal code.' })
  @IsOptional()
  @Transform(trim)
  @Matches(/^[A-Za-z0-9 -]{3,12}$/, {
    message: 'postalCode must be a postal code',
  })
  postalCode?: string;

  @ApiPropertyOptional({
    example: '1990-01-15',
    description:
      'A person’s date of birth (YYYY-MM-DD); required for `person`.',
  })
  @ValidateIf(
    (dto: CreateTransferAccountDto) =>
      dto.type === 'person' || dto.dateOfBirth !== undefined,
  )
  @IsNotEmpty({ message: 'dateOfBirth is required for a person' })
  @Matches(/^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
    message: 'dateOfBirth must be a date (YYYY-MM-DD)',
  })
  dateOfBirth?: string;
}
