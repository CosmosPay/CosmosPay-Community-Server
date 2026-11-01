import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import {
  ACCOUNT_CLASSES,
  BANK_ACCOUNT_TYPES,
  BLINDPAY_RAILS,
  type AccountClass,
  type BankAccountType,
  type BlindpayRail,
} from '@/native-plugins/blindpay/blindpay.constants';

/**
 * Creates a fiat bank account for a receiver — the destination for offramp
 * payouts. BlindPay has one endpoint but each `type` (rail) expects a different
 * field set; this DTO is the curated superset across the supported rails, sent
 * through as-is (snake_case, mirroring BlindPay). Only the fields relevant to the
 * chosen rail need be supplied.
 */
@ApiSchema({
  description:
    "A fiat bank account to add to a receiver, where its offramp payouts settle. `type` names the rail and only that rail's fields are needed (`GET /v1/kyc/bank-details?rail=` lists them); the body is forwarded to BlindPay.",
})
export class CreateBankAccountDto {
  @ApiProperty({
    enum: BLINDPAY_RAILS,
    example: 'ach',
    description:
      'The rail the account settles on; it decides which of the rail-specific fields apply.',
  })
  @IsIn(BLINDPAY_RAILS)
  type!: BlindpayRail;

  @ApiProperty({
    example: 'Acme payouts (USD)',
    description: 'A label for the account, forwarded to BlindPay.',
  })
  @IsString()
  name!: string;

  @ApiPropertyOptional({
    enum: ACCOUNT_CLASSES,
    example: 'individual',
    description:
      'Ownership class of the account (`individual` or `business`), used by the US and EUR rails.',
  })
  @IsOptional()
  @IsIn(ACCOUNT_CLASSES)
  account_class?: AccountClass;

  @ApiPropertyOptional({
    enum: BANK_ACCOUNT_TYPES,
    example: 'checking',
    description:
      'Checking or savings account, for the rails that distinguish them.',
  })
  @IsOptional()
  @IsIn(BANK_ACCOUNT_TYPES)
  account_type?: BankAccountType;

  @ApiPropertyOptional({
    example: 'Jane Doe',
    description: "Name of the account's beneficiary.",
  })
  @IsOptional()
  @IsString()
  beneficiary_name?: string;

  @ApiPropertyOptional({
    example: 'first_party',
    description:
      'Relationship to the recipient, as a BlindPay code (for example `first_party`).',
  })
  @IsOptional()
  @IsString()
  recipient_relationship?: string;

  // --- ACH / Wire / RTP (US) ---
  @ApiPropertyOptional({
    example: '0123456789',
    description:
      'Bank account number (`ach`, `wire` and `rtp` rails, United States).',
  })
  @IsOptional()
  @IsString()
  account_number?: string;

  @ApiPropertyOptional({
    example: '021000021',
    description:
      'Bank routing number (`ach`, `wire` and `rtp` rails, United States).',
  })
  @IsOptional()
  @IsString()
  routing_number?: string;

  // Compliance fields ACH/Wire/RTP/SWIFT may require (e.g. business accounts,
  // or beneficiaries in certain countries).
  @ApiPropertyOptional({
    example: '541511',
    description: 'NAICS code; required for business-class US/SWIFT accounts.',
  })
  @IsOptional()
  @IsString()
  business_industry?: string;

  @ApiPropertyOptional({
    example: '+12025550123',
    description:
      'Phone number with its country code; a compliance field the ACH, Wire, RTP and SWIFT rails may require.',
  })
  @IsOptional()
  @IsString()
  phone_number?: string;

  @ApiPropertyOptional({
    example: '123456789',
    description:
      'Tax id; a compliance field the ACH, Wire, RTP and SWIFT rails may require.',
  })
  @IsOptional()
  @IsString()
  tax_id?: string;

  // --- PIX (BR) ---
  @ApiPropertyOptional({
    example: 'jane@acme.com',
    description:
      'PIX key of the destination account, such as an email address (`pix` rail, Brazil).',
  })
  @IsOptional()
  @IsString()
  pix_key?: string;

  // --- PIX safe (BR) ---
  @ApiPropertyOptional({
    description:
      'Bank code of the destination account (`pix_safe` rail, Brazil).',
  })
  @IsOptional()
  @IsString()
  pix_safe_bank_code?: string;

  @ApiPropertyOptional({
    description:
      'Branch code of the destination account (`pix_safe` rail, Brazil).',
  })
  @IsOptional()
  @IsString()
  pix_safe_branch_code?: string;

  @ApiPropertyOptional({
    description:
      'CPF or CNPJ (Brazilian tax id) of the account holder (`pix_safe` rail, Brazil).',
  })
  @IsOptional()
  @IsString()
  pix_safe_cpf_cnpj?: string;

  // --- TED (BR) ---
  @ApiPropertyOptional({
    description: 'Bank code of the destination account (`ted` rail, Brazil).',
  })
  @IsOptional()
  @IsString()
  ted_bank_code?: string;

  @ApiPropertyOptional({
    description: 'Branch code of the destination account (`ted` rail, Brazil).',
  })
  @IsOptional()
  @IsString()
  ted_branch_code?: string;

  @ApiPropertyOptional({
    description:
      'CPF or CNPJ (Brazilian tax id) of the account holder (`ted` rail, Brazil).',
  })
  @IsOptional()
  @IsString()
  ted_cpf_cnpj?: string;

  // --- Transfers 3.0 (AR) ---
  @ApiPropertyOptional({
    example: '0000003100010000000001',
    description:
      'Destination CVU, CBU or alias (`transfers_bitso` rail, Argentina); say which in `transfers_type`.',
  })
  @IsOptional()
  @IsString()
  transfers_account?: string;

  @ApiPropertyOptional({ example: 'CBU', description: 'CVU | CBU | ALIAS' })
  @IsOptional()
  @IsString()
  transfers_type?: string;

  // --- SPEI (MX) ---
  @ApiPropertyOptional({
    example: '012345678901234567',
    description:
      'CLABE of the destination account (`spei_bitso` rail, Mexico).',
  })
  @IsOptional()
  @IsString()
  spei_clabe?: string;

  @ApiPropertyOptional({
    description:
      'Institution code of the destination bank (`spei_bitso` rail, Mexico).',
  })
  @IsOptional()
  @IsString()
  spei_institution_code?: string;

  @ApiPropertyOptional({
    description:
      'SPEI protocol value, forwarded to BlindPay (`spei_bitso` rail, Mexico).',
  })
  @IsOptional()
  @IsString()
  spei_protocol?: string;

  // --- ACH COP (CO) ---
  @ApiPropertyOptional({
    description: 'Beneficiary first name (`ach_cop_bitso` rail, Colombia).',
  })
  @IsOptional()
  @IsString()
  ach_cop_beneficiary_first_name?: string;

  @ApiPropertyOptional({
    description: 'Beneficiary last name (`ach_cop_bitso` rail, Colombia).',
  })
  @IsOptional()
  @IsString()
  ach_cop_beneficiary_last_name?: string;

  @ApiPropertyOptional({
    description:
      "Number of the beneficiary's identity document (`ach_cop_bitso` rail, Colombia).",
  })
  @IsOptional()
  @IsString()
  ach_cop_document_id?: string;

  @ApiPropertyOptional({
    description:
      "Type of the beneficiary's identity document (`ach_cop_bitso` rail, Colombia).",
  })
  @IsOptional()
  @IsString()
  ach_cop_document_type?: string;

  @ApiPropertyOptional({
    description: 'Beneficiary email address (`ach_cop_bitso` rail, Colombia).',
  })
  @IsOptional()
  @IsString()
  ach_cop_email?: string;

  @ApiPropertyOptional({
    description:
      'Code of the destination bank (`ach_cop_bitso` rail, Colombia).',
  })
  @IsOptional()
  @IsString()
  ach_cop_bank_code?: string;

  @ApiPropertyOptional({
    description:
      'Destination bank account number (`ach_cop_bitso` rail, Colombia).',
  })
  @IsOptional()
  @IsString()
  ach_cop_bank_account?: string;

  // --- International SWIFT ---
  @ApiPropertyOptional({
    description: 'Name of the account holder (`international_swift` rail).',
  })
  @IsOptional()
  @IsString()
  swift_account_holder_name?: string;

  @ApiPropertyOptional({
    description:
      'Account number or IBAN of the destination account (`international_swift` rail).',
  })
  @IsOptional()
  @IsString()
  swift_account_number_iban?: string;

  @ApiPropertyOptional({
    description:
      'SWIFT/BIC code of the destination bank (`international_swift` rail).',
  })
  @IsOptional()
  @IsString()
  swift_code_bic?: string;

  @ApiPropertyOptional({
    description: 'Name of the destination bank (`international_swift` rail).',
  })
  @IsOptional()
  @IsString()
  swift_bank_name?: string;

  @ApiPropertyOptional({
    description:
      "First line of the destination bank's address (`international_swift` rail).",
  })
  @IsOptional()
  @IsString()
  swift_bank_address_line_1?: string;

  @ApiPropertyOptional({
    description: 'City of the destination bank (`international_swift` rail).',
  })
  @IsOptional()
  @IsString()
  swift_bank_city?: string;

  @ApiPropertyOptional({
    description:
      'State, province or region of the destination bank (`international_swift` rail).',
  })
  @IsOptional()
  @IsString()
  swift_bank_state_province_region?: string;

  @ApiPropertyOptional({
    description:
      'Country of the destination bank (`international_swift` rail).',
  })
  @IsOptional()
  @IsString()
  swift_bank_country?: string;

  @ApiPropertyOptional({
    description:
      'Postal code of the destination bank (`international_swift` rail).',
  })
  @IsOptional()
  @IsString()
  swift_bank_postal_code?: string;

  @ApiPropertyOptional({
    description:
      "First line of the beneficiary's address (`international_swift` rail).",
  })
  @IsOptional()
  @IsString()
  swift_beneficiary_address_line_1?: string;

  @ApiPropertyOptional({
    description:
      "City of the beneficiary's address (`international_swift` rail).",
  })
  @IsOptional()
  @IsString()
  swift_beneficiary_city?: string;

  @ApiPropertyOptional({
    description:
      "State, province or region of the beneficiary's address (`international_swift` rail).",
  })
  @IsOptional()
  @IsString()
  swift_beneficiary_state_province_region?: string;

  @ApiPropertyOptional({
    description:
      "Country of the beneficiary's address (`international_swift` rail).",
  })
  @IsOptional()
  @IsString()
  swift_beneficiary_country?: string;

  @ApiPropertyOptional({
    description:
      "Postal code of the beneficiary's address (`international_swift` rail).",
  })
  @IsOptional()
  @IsString()
  swift_beneficiary_postal_code?: string;

  @ApiPropertyOptional({
    description:
      "Second line of the destination bank's address (`international_swift` rail).",
  })
  @IsOptional()
  @IsString()
  swift_bank_address_line_2?: string;

  @ApiPropertyOptional({
    description:
      "Second line of the beneficiary's address (`international_swift` rail).",
  })
  @IsOptional()
  @IsString()
  swift_beneficiary_address_line_2?: string;

  @ApiPropertyOptional({ description: 'SWIFT payment/purpose code.' })
  @IsOptional()
  @IsString()
  swift_payment_code?: string;

  @ApiPropertyOptional({
    description:
      'SWIFT/BIC code of the intermediary bank, when the transfer goes through one (`international_swift` rail).',
  })
  @IsOptional()
  @IsString()
  swift_intermediary_bank_swift_code_bic?: string;

  @ApiPropertyOptional({
    description:
      'Account number or IBAN at the intermediary bank (`international_swift` rail).',
  })
  @IsOptional()
  @IsString()
  swift_intermediary_bank_account_number_iban?: string;

  @ApiPropertyOptional({
    description: 'Name of the intermediary bank (`international_swift` rail).',
  })
  @IsOptional()
  @IsString()
  swift_intermediary_bank_name?: string;

  @ApiPropertyOptional({
    description:
      'Country of the intermediary bank (`international_swift` rail).',
  })
  @IsOptional()
  @IsString()
  swift_intermediary_bank_country?: string;

  // --- SEPA (EUR) ---
  @ApiPropertyOptional({
    description: 'IBAN of the destination account (`sepa` rail, EUR).',
  })
  @IsOptional()
  @IsString()
  sepa_iban?: string;

  @ApiPropertyOptional({
    description: "BIC of the beneficiary's bank (`sepa` rail).",
  })
  @IsOptional()
  @IsString()
  sepa_beneficiary_bic?: string;

  @ApiPropertyOptional({
    description: 'Legal name of the beneficiary (`sepa` rail).',
  })
  @IsOptional()
  @IsString()
  sepa_beneficiary_legal_name?: string;

  @ApiPropertyOptional({
    description: "First line of the beneficiary's address (`sepa` rail).",
  })
  @IsOptional()
  @IsString()
  sepa_beneficiary_address_line_1?: string;

  @ApiPropertyOptional({
    description: "City of the beneficiary's address (`sepa` rail).",
  })
  @IsOptional()
  @IsString()
  sepa_beneficiary_city?: string;

  @ApiPropertyOptional({
    description: "Postal code of the beneficiary's address (`sepa` rail).",
  })
  @IsOptional()
  @IsString()
  sepa_beneficiary_postal_code?: string;

  @ApiPropertyOptional({
    description: "Country of the beneficiary's address (`sepa` rail).",
  })
  @IsOptional()
  @IsString()
  sepa_beneficiary_country?: string;

  @ApiPropertyOptional({
    description: "Second line of the beneficiary's address (`sepa` rail).",
  })
  @IsOptional()
  @IsString()
  sepa_beneficiary_address_line_2?: string;

  @ApiPropertyOptional({
    description:
      "State, province or region of the beneficiary's address (`sepa` rail).",
  })
  @IsOptional()
  @IsString()
  sepa_beneficiary_state_province_region?: string;

  // --- Shared address (US/SWIFT/SEPA beneficiary) ---
  @ApiPropertyOptional({
    description:
      "First line of the beneficiary's address, for the US, SWIFT and SEPA rails.",
  })
  @IsOptional()
  @IsString()
  address_line_1?: string;

  @ApiPropertyOptional({
    description:
      "Second line of the beneficiary's address, for the US, SWIFT and SEPA rails.",
  })
  @IsOptional()
  @IsString()
  address_line_2?: string;

  @ApiPropertyOptional({
    description:
      "City of the beneficiary's address, for the US, SWIFT and SEPA rails.",
  })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({
    description:
      "State, province or region of the beneficiary's address, for the US, SWIFT and SEPA rails.",
  })
  @IsOptional()
  @IsString()
  state_province_region?: string;

  @ApiPropertyOptional({
    description:
      "Country of the beneficiary's address, for the US, SWIFT and SEPA rails.",
  })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({
    description:
      "Postal code of the beneficiary's address, for the US, SWIFT and SEPA rails.",
  })
  @IsOptional()
  @IsString()
  postal_code?: string;
}
