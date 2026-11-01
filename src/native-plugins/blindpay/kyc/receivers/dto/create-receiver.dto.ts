import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO31661Alpha2,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  KYC_TYPES,
  RECEIVER_TYPES,
  type KycType,
  type ReceiverType,
} from '@/native-plugins/blindpay/blindpay.constants';
import {
  COUNTRY_CODE_RE,
  ISO_DATETIME_RE,
  RECEIVER_WEBSITE_MAX_LENGTH,
  RECEIVER_WEBSITE_PROTOCOLS,
} from '@/native-plugins/blindpay/kyc/kyc.constants';

/** An ISO 3166-1 alpha-2 code that exists, spelled upper case. */
const IsCountryCode = () =>
  applyDecorators(
    IsISO31661Alpha2(),
    Matches(COUNTRY_CODE_RE, {
      message: '$property must be an upper-case ISO 3166-1 alpha-2 code',
    }),
  );

/** A real calendar date-time with an offset — never a bare date. */
const IsIsoDateTime = () =>
  applyDecorators(
    IsISO8601({ strict: true, strictSeparator: true }),
    Matches(ISO_DATETIME_RE, {
      message: '$property must be an ISO 8601 date-time with an offset',
    }),
  );

/**
 * Beneficial owner / controlling person for a business (KYB) receiver.
 */
@ApiSchema({
  description:
    'A beneficial owner or controlling person of a business (KYB) receiver, stored with it and sent to BlindPay when the receiver is enabled.',
})
export class ReceiverOwnerDto {
  @ApiPropertyOptional({
    example: 'beneficial_owner',
    description:
      "The person's role in the business, as a BlindPay code (for example `beneficial_owner`).",
  })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({ example: 'Jane', description: "Owner's first name." })
  @IsOptional()
  @IsString()
  first_name?: string;

  @ApiPropertyOptional({ example: 'Doe', description: "Owner's last name." })
  @IsOptional()
  @IsString()
  last_name?: string;

  @ApiPropertyOptional({
    example: '1985-04-12T00:00:00.000Z',
    format: 'date-time',
    description:
      'ISO 8601 date-time with an offset (BlindPay rejects date-only values).',
  })
  @IsOptional()
  @IsIsoDateTime()
  date_of_birth?: string;

  @ApiPropertyOptional({
    example: '123-45-6789',
    description: "Owner's tax id.",
  })
  @IsOptional()
  @IsString()
  tax_id?: string;

  @ApiPropertyOptional({
    example: 'US',
    pattern: '^[A-Z]{2}$',
    description: 'ISO 3166-1 alpha-2 country code, upper case',
  })
  @IsOptional()
  @IsCountryCode()
  country?: string;

  @ApiPropertyOptional({
    example: '123 Main St',
    description: "First line of the owner's address.",
  })
  @IsOptional()
  @IsString()
  address_line_1?: string;

  @ApiPropertyOptional({ description: "Second line of the owner's address." })
  @IsOptional()
  @IsString()
  address_line_2?: string;

  @ApiPropertyOptional({
    example: 'New York',
    description: "City of the owner's address.",
  })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({
    example: 'NY',
    description: "State, province or region of the owner's address.",
  })
  @IsOptional()
  @IsString()
  state_province_region?: string;

  @ApiPropertyOptional({
    example: '10001',
    description: "Postal code of the owner's address.",
  })
  @IsOptional()
  @IsString()
  postal_code?: string;

  @ApiPropertyOptional({
    example: 25.5,
    minimum: 0,
    maximum: 100,
    description: 'Ownership percentage',
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  ownership_percentage?: number;

  @ApiPropertyOptional({
    example: 'Director',
    description: "Owner's title in the business (for example `Director`).",
  })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({
    example: 'US',
    pattern: '^[A-Z]{2}$',
    description: 'ISO 3166-1 alpha-2 country code, upper case',
  })
  @IsOptional()
  @IsCountryCode()
  id_doc_country?: string;

  @ApiPropertyOptional({
    example: 'PASSPORT',
    description:
      "Type of the owner's identity document (for example `PASSPORT`).",
  })
  @IsOptional()
  @IsString()
  id_doc_type?: string;

  @ApiPropertyOptional({ description: 'file_url from POST /v1/kyc/upload' })
  @IsOptional()
  @IsString()
  id_doc_front_file?: string;

  @ApiPropertyOptional({
    description:
      "Back of the owner's identity document: a `file_url` from `POST /v1/kyc/upload`.",
  })
  @IsOptional()
  @IsString()
  id_doc_back_file?: string;

  @ApiPropertyOptional({
    example: 'UTILITY_BILL',
    description:
      "Type of the owner's proof-of-address document (for example `UTILITY_BILL`).",
  })
  @IsOptional()
  @IsString()
  proof_of_address_doc_type?: string;

  @ApiPropertyOptional({ description: 'file_url from POST /v1/kyc/upload' })
  @IsOptional()
  @IsString()
  proof_of_address_doc_file?: string;

  @ApiPropertyOptional({ description: "Owner's tax id type." })
  @IsOptional()
  @IsString()
  tax_type?: string;
}

/**
 * Creates a BlindPay receiver (the KYC/KYB entity). Fields mirror BlindPay's API
 * 1:1 (snake_case) so the payload passes through faithfully; the curated set
 * below covers individual standard/enhanced KYC and business KYB. Document fields
 * (`*_file`) take a `file_url` returned by `POST /v1/kyc/upload`.
 */
@ApiSchema({
  description:
    'A receiver, the person (KYC) or business (KYB) behind onramp and offramp: stored here and created at BlindPay only on enable. With KYC data (`tax_id`, `date_of_birth`, `id_doc_front_file`, `selfie_file`, `legal_name`, `formation_date` or `owners`) it starts in `pending_review`, otherwise in `inactive`.',
})
export class CreateReceiverDto {
  @ApiProperty({
    enum: RECEIVER_TYPES,
    example: 'individual',
    description:
      '`individual` for a person (KYC) or `business` for a company (KYB).',
  })
  @IsIn(RECEIVER_TYPES)
  type!: ReceiverType;

  @ApiProperty({
    enum: KYC_TYPES,
    example: 'standard',
    description:
      'Depth of compliance verification: `light`, `standard` or `enhanced`.',
  })
  @IsIn(KYC_TYPES)
  kyc_type!: KycType;

  @ApiProperty({
    example: 'jane@acme.com',
    description: "Receiver's email address, at most 160 characters.",
  })
  @IsEmail()
  @MaxLength(160)
  email!: string;

  @ApiProperty({
    example: 'US',
    pattern: '^[A-Z]{2}$',
    description: 'ISO 3166-1 alpha-2 country code, upper case',
  })
  @IsCountryCode()
  country!: string;

  // --- Individual ---
  @ApiPropertyOptional({
    example: 'Jane',
    description:
      'First name of an individual receiver; with `last_name` it forms the receiver `name`.',
  })
  @IsOptional()
  @IsString()
  first_name?: string;

  @ApiPropertyOptional({
    example: 'Doe',
    description: 'Last name of an individual receiver.',
  })
  @IsOptional()
  @IsString()
  last_name?: string;

  @ApiPropertyOptional({
    example: '1985-04-12T00:00:00.000Z',
    format: 'date-time',
    description:
      'ISO 8601 date-time with an offset (BlindPay rejects date-only values).',
  })
  @IsOptional()
  @IsIsoDateTime()
  date_of_birth?: string;

  @ApiPropertyOptional({
    example: '123-45-6789',
    description: "Receiver's tax id.",
  })
  @IsOptional()
  @IsString()
  tax_id?: string;

  @ApiPropertyOptional({
    example: 'Engineer',
    description: 'Occupation of an individual receiver.',
  })
  @IsOptional()
  @IsString()
  occupation?: string;

  @ApiPropertyOptional({
    example: 'US',
    pattern: '^[A-Z]{2}$',
    description: 'ISO 3166-1 alpha-2 country code, upper case',
  })
  @IsOptional()
  @IsCountryCode()
  id_doc_country?: string;

  @ApiPropertyOptional({
    example: 'PASSPORT',
    description: 'Type of the identity document (for example `PASSPORT`).',
  })
  @IsOptional()
  @IsString()
  id_doc_type?: string;

  @ApiPropertyOptional({ description: 'file_url from POST /v1/kyc/upload' })
  @IsOptional()
  @IsString()
  id_doc_front_file?: string;

  @ApiPropertyOptional({
    description:
      'Back of the identity document: a `file_url` from `POST /v1/kyc/upload`.',
  })
  @IsOptional()
  @IsString()
  id_doc_back_file?: string;

  @ApiPropertyOptional({
    description:
      'Selfie of the person: a `file_url` from `POST /v1/kyc/upload`.',
  })
  @IsOptional()
  @IsString()
  selfie_file?: string;

  @ApiPropertyOptional({
    example: 'receiving_payments',
    description:
      'Purpose of the account, as a BlindPay code (for example `receiving_payments`).',
  })
  @IsOptional()
  @IsString()
  account_purpose?: string;

  @ApiPropertyOptional({
    description:
      'Free-text account purpose, forwarded to BlindPay with `account_purpose`.',
  })
  @IsOptional()
  @IsString()
  account_purpose_other?: string;

  @ApiPropertyOptional({
    example: 'employment',
    description:
      'Type of the source-of-funds document, as a BlindPay code (for example `employment`).',
  })
  @IsOptional()
  @IsString()
  source_of_funds_doc_type?: string;

  @ApiPropertyOptional({
    description:
      'Source-of-funds document: a `file_url` from `POST /v1/kyc/upload`.',
  })
  @IsOptional()
  @IsString()
  source_of_funds_doc_file?: string;

  @ApiPropertyOptional({
    description: "Source of the receiver's wealth, forwarded to BlindPay.",
  })
  @IsOptional()
  @IsString()
  source_of_wealth?: string;

  @ApiPropertyOptional({
    example: 'bank_statement',
    description: 'master_service_agreement | salary_slip | bank_statement',
  })
  @IsOptional()
  @IsString()
  sole_proprietor_doc_type?: string;

  @ApiPropertyOptional({
    example: 'UTILITY_BILL',
    description:
      'Type of the proof-of-address document (for example `UTILITY_BILL`).',
  })
  @IsOptional()
  @IsString()
  proof_of_address_doc_type?: string;

  @ApiPropertyOptional({
    description:
      'Proof-of-address document: a `file_url` from `POST /v1/kyc/upload`.',
  })
  @IsOptional()
  @IsString()
  proof_of_address_doc_file?: string;

  @ApiPropertyOptional({
    example: 'self',
    description:
      'Relationship to the recipient, as a BlindPay code (for example `self`).',
  })
  @IsOptional()
  @IsString()
  recipient_relationship?: string;

  // --- Enhanced KYC extras ---
  @ApiPropertyOptional({
    example: 'business_transactions',
    description:
      "Purpose of the receiver's transactions, as a BlindPay code (for example `business_transactions`); an enhanced KYC field.",
  })
  @IsOptional()
  @IsString()
  purpose_of_transactions?: string;

  @ApiPropertyOptional({
    description:
      'Free-text explanation of `purpose_of_transactions`; an enhanced KYC field.',
  })
  @IsOptional()
  @IsString()
  purpose_of_transactions_explanation?: string;

  // --- Business (KYB) ---
  @ApiPropertyOptional({
    example: 'Acme Inc.',
    description:
      "Legal name of a business receiver; it becomes the receiver's `name`.",
  })
  @IsOptional()
  @IsString()
  legal_name?: string;

  @ApiPropertyOptional({
    example: 'Acme',
    description: 'Alternate name of a business receiver.',
  })
  @IsOptional()
  @IsString()
  alternate_name?: string;

  @ApiPropertyOptional({
    example: 'cooperative',
    description:
      'Type of business, as a BlindPay code (for example `cooperative`).',
  })
  @IsOptional()
  @IsString()
  business_type?: string;

  @ApiPropertyOptional({
    example: '541511',
    description:
      'Industry code of a business receiver, such as the NAICS code `541511`.',
  })
  @IsOptional()
  @IsString()
  business_industry?: string;

  @ApiPropertyOptional({ description: 'What a business receiver does.' })
  @IsOptional()
  @IsString()
  business_description?: string;

  @ApiPropertyOptional({
    example: '2015-01-01T00:00:00.000Z',
    format: 'date-time',
    description:
      'ISO 8601 date-time with an offset (BlindPay rejects date-only values).',
  })
  @IsOptional()
  @IsIsoDateTime()
  formation_date?: string;

  @ApiPropertyOptional({
    example: '1000000_4999999',
    description:
      'Estimated annual revenue band of a business receiver, as a BlindPay code (for example `1000000_4999999`).',
  })
  @IsOptional()
  @IsString()
  estimated_annual_revenue?: string;

  @ApiPropertyOptional({
    example: false,
    description: 'Whether a business receiver is publicly traded.',
  })
  @IsOptional()
  @IsBoolean()
  publicly_traded?: boolean;

  @ApiPropertyOptional({
    example: 'https://acme.com',
    description: 'Absolute http(s) URL, without credentials.',
    maxLength: RECEIVER_WEBSITE_MAX_LENGTH,
  })
  @IsOptional()
  @IsUrl({
    protocols: RECEIVER_WEBSITE_PROTOCOLS,
    require_protocol: true,
    require_tld: true,
    disallow_auth: true,
  })
  @MaxLength(RECEIVER_WEBSITE_MAX_LENGTH)
  website?: string;

  @ApiPropertyOptional({
    description:
      'Incorporation document of a business receiver: a `file_url` from `POST /v1/kyc/upload`.',
  })
  @IsOptional()
  @IsString()
  incorporation_doc_file?: string;

  @ApiPropertyOptional({
    description:
      'Proof-of-ownership document of a business receiver: a `file_url` from `POST /v1/kyc/upload`.',
  })
  @IsOptional()
  @IsString()
  proof_of_ownership_doc_file?: string;

  @ApiPropertyOptional({
    type: [ReceiverOwnerDto],
    description:
      'Beneficial owners and controlling persons of a business receiver.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceiverOwnerDto)
  owners?: ReceiverOwnerDto[];

  // --- Shared address / contact / metadata ---
  @ApiPropertyOptional({
    example: '123 Main St',
    description: "First line of the receiver's address.",
  })
  @IsOptional()
  @IsString()
  address_line_1?: string;

  @ApiPropertyOptional({
    description: "Second line of the receiver's address.",
  })
  @IsOptional()
  @IsString()
  address_line_2?: string;

  @ApiPropertyOptional({
    example: 'New York',
    description: "City of the receiver's address.",
  })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({
    example: 'NY',
    description: "State, province or region of the receiver's address.",
  })
  @IsOptional()
  @IsString()
  state_province_region?: string;

  @ApiPropertyOptional({
    example: '10001',
    description: "Postal code of the receiver's address.",
  })
  @IsOptional()
  @IsString()
  postal_code?: string;

  @ApiPropertyOptional({
    example: '+12025550123',
    description: "Receiver's phone number with its country code.",
  })
  @IsOptional()
  @IsString()
  phone_number?: string;

  @ApiPropertyOptional({
    description: "Receiver's IP address, forwarded to BlindPay.",
  })
  @IsOptional()
  @IsString()
  ip_address?: string;

  @ApiPropertyOptional({ description: 'Your own id for this receiver' })
  @IsOptional()
  @IsString()
  external_id?: string;

  @ApiPropertyOptional({
    description:
      'URL of a display image for the receiver. With `external_id`, the only field a non-admin key may change once the receiver exists at BlindPay.',
  })
  @IsOptional()
  @IsString()
  image_url?: string;

  @ApiPropertyOptional({
    description:
      'Accepted terms-of-service id (from the redirect of POST /v1/kyc/terms-of-service). Required by BlindPay to create a receiver.',
  })
  @IsOptional()
  @IsString()
  tos_id?: string;
}
