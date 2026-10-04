import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
export class ReceiverOwnerDto {
  @ApiPropertyOptional({ example: 'beneficial_owner' })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({ example: 'Jane' })
  @IsOptional()
  @IsString()
  first_name?: string;

  @ApiPropertyOptional({ example: 'Doe' })
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

  @ApiPropertyOptional({ example: '123-45-6789' })
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

  @ApiPropertyOptional({ example: '123 Main St' })
  @IsOptional()
  @IsString()
  address_line_1?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address_line_2?: string;

  @ApiPropertyOptional({ example: 'New York' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ example: 'NY' })
  @IsOptional()
  @IsString()
  state_province_region?: string;

  @ApiPropertyOptional({ example: '10001' })
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

  @ApiPropertyOptional({ example: 'Director' })
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

  @ApiPropertyOptional({ example: 'PASSPORT' })
  @IsOptional()
  @IsString()
  id_doc_type?: string;

  @ApiPropertyOptional({ description: 'file_url from POST /v1/kyc/upload' })
  @IsOptional()
  @IsString()
  id_doc_front_file?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  id_doc_back_file?: string;

  @ApiPropertyOptional({ example: 'UTILITY_BILL' })
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
export class CreateReceiverDto {
  @ApiProperty({ enum: RECEIVER_TYPES, example: 'individual' })
  @IsIn(RECEIVER_TYPES)
  type!: ReceiverType;

  @ApiProperty({ enum: KYC_TYPES, example: 'standard' })
  @IsIn(KYC_TYPES)
  kyc_type!: KycType;

  @ApiProperty({ example: 'jane@acme.com' })
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
  @ApiPropertyOptional({ example: 'Jane' })
  @IsOptional()
  @IsString()
  first_name?: string;

  @ApiPropertyOptional({ example: 'Doe' })
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

  @ApiPropertyOptional({ example: '123-45-6789' })
  @IsOptional()
  @IsString()
  tax_id?: string;

  @ApiPropertyOptional({ example: 'Engineer' })
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

  @ApiPropertyOptional({ example: 'PASSPORT' })
  @IsOptional()
  @IsString()
  id_doc_type?: string;

  @ApiPropertyOptional({ description: 'file_url from POST /v1/kyc/upload' })
  @IsOptional()
  @IsString()
  id_doc_front_file?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  id_doc_back_file?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  selfie_file?: string;

  @ApiPropertyOptional({ example: 'receiving_payments' })
  @IsOptional()
  @IsString()
  account_purpose?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  account_purpose_other?: string;

  @ApiPropertyOptional({ example: 'employment' })
  @IsOptional()
  @IsString()
  source_of_funds_doc_type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  source_of_funds_doc_file?: string;

  @ApiPropertyOptional()
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

  @ApiPropertyOptional({ example: 'UTILITY_BILL' })
  @IsOptional()
  @IsString()
  proof_of_address_doc_type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  proof_of_address_doc_file?: string;

  @ApiPropertyOptional({ example: 'self' })
  @IsOptional()
  @IsString()
  recipient_relationship?: string;

  // --- Enhanced KYC extras ---
  @ApiPropertyOptional({ example: 'business_transactions' })
  @IsOptional()
  @IsString()
  purpose_of_transactions?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  purpose_of_transactions_explanation?: string;

  // --- Business (KYB) ---
  @ApiPropertyOptional({ example: 'Acme Inc.' })
  @IsOptional()
  @IsString()
  legal_name?: string;

  @ApiPropertyOptional({ example: 'Acme' })
  @IsOptional()
  @IsString()
  alternate_name?: string;

  @ApiPropertyOptional({ example: 'cooperative' })
  @IsOptional()
  @IsString()
  business_type?: string;

  @ApiPropertyOptional({ example: '541511' })
  @IsOptional()
  @IsString()
  business_industry?: string;

  @ApiPropertyOptional()
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

  @ApiPropertyOptional({ example: '1000000_4999999' })
  @IsOptional()
  @IsString()
  estimated_annual_revenue?: string;

  @ApiPropertyOptional({ example: false })
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  incorporation_doc_file?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  proof_of_ownership_doc_file?: string;

  @ApiPropertyOptional({ type: [ReceiverOwnerDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceiverOwnerDto)
  owners?: ReceiverOwnerDto[];

  // --- Shared address / contact / metadata ---
  @ApiPropertyOptional({ example: '123 Main St' })
  @IsOptional()
  @IsString()
  address_line_1?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address_line_2?: string;

  @ApiPropertyOptional({ example: 'New York' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ example: 'NY' })
  @IsOptional()
  @IsString()
  state_province_region?: string;

  @ApiPropertyOptional({ example: '10001' })
  @IsOptional()
  @IsString()
  postal_code?: string;

  @ApiPropertyOptional({ example: '+12025550123' })
  @IsOptional()
  @IsString()
  phone_number?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ip_address?: string;

  @ApiPropertyOptional({ description: 'Your own id for this receiver' })
  @IsOptional()
  @IsString()
  external_id?: string;

  @ApiPropertyOptional()
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
