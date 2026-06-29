import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import {
  ACCOUNT_CLASSES,
  BANK_ACCOUNT_TYPES,
  BLINDPAY_RAILS,
  type AccountClass,
  type BankAccountType,
  type BlindpayRail,
} from '../../../blindpay/blindpay.constants';

/**
 * Creates a fiat bank account for a receiver — the destination for offramp
 * payouts. BlindPay has one endpoint but each `type` (rail) expects a different
 * field set; this DTO is the curated superset across the supported rails, sent
 * through as-is (snake_case, mirroring BlindPay). Only the fields relevant to the
 * chosen rail need be supplied.
 */
export class CreateBankAccountDto {
  @ApiProperty({ enum: BLINDPAY_RAILS, example: 'ach' })
  @IsIn(BLINDPAY_RAILS)
  type!: BlindpayRail;

  @ApiProperty({ example: 'Acme payouts — USD' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ enum: ACCOUNT_CLASSES, example: 'individual' })
  @IsOptional()
  @IsIn(ACCOUNT_CLASSES)
  account_class?: AccountClass;

  @ApiPropertyOptional({ enum: BANK_ACCOUNT_TYPES, example: 'checking' })
  @IsOptional()
  @IsIn(BANK_ACCOUNT_TYPES)
  account_type?: BankAccountType;

  @ApiPropertyOptional({ example: 'Jane Doe' })
  @IsOptional()
  @IsString()
  beneficiary_name?: string;

  @ApiPropertyOptional({ example: 'first_party' })
  @IsOptional()
  @IsString()
  recipient_relationship?: string;

  // --- ACH / Wire / RTP (US) ---
  @ApiPropertyOptional({ example: '0123456789' })
  @IsOptional()
  @IsString()
  account_number?: string;

  @ApiPropertyOptional({ example: '021000021' })
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

  @ApiPropertyOptional({ example: '+12025550123' })
  @IsOptional()
  @IsString()
  phone_number?: string;

  @ApiPropertyOptional({ example: '123456789' })
  @IsOptional()
  @IsString()
  tax_id?: string;

  // --- PIX (BR) ---
  @ApiPropertyOptional({ example: 'jane@acme.com' })
  @IsOptional()
  @IsString()
  pix_key?: string;

  // --- PIX safe (BR) ---
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pix_safe_bank_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pix_safe_branch_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pix_safe_cpf_cnpj?: string;

  // --- TED (BR) ---
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ted_bank_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ted_branch_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ted_cpf_cnpj?: string;

  // --- Transfers 3.0 (AR) ---
  @ApiPropertyOptional({ example: '0000003100010000000001' })
  @IsOptional()
  @IsString()
  transfers_account?: string;

  @ApiPropertyOptional({ example: 'CBU', description: 'CVU | CBU | ALIAS' })
  @IsOptional()
  @IsString()
  transfers_type?: string;

  // --- SPEI (MX) ---
  @ApiPropertyOptional({ example: '012345678901234567' })
  @IsOptional()
  @IsString()
  spei_clabe?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  spei_institution_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  spei_protocol?: string;

  // --- ACH COP (CO) ---
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ach_cop_beneficiary_first_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ach_cop_beneficiary_last_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ach_cop_document_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ach_cop_document_type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ach_cop_email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ach_cop_bank_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ach_cop_bank_account?: string;

  // --- International SWIFT ---
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_account_holder_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_account_number_iban?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_code_bic?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_bank_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_bank_address_line_1?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_bank_city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_bank_state_province_region?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_bank_country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_bank_postal_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_beneficiary_address_line_1?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_beneficiary_city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_beneficiary_state_province_region?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_beneficiary_country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_beneficiary_postal_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_bank_address_line_2?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_beneficiary_address_line_2?: string;

  @ApiPropertyOptional({ description: 'SWIFT payment/purpose code.' })
  @IsOptional()
  @IsString()
  swift_payment_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_intermediary_bank_swift_code_bic?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_intermediary_bank_account_number_iban?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_intermediary_bank_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_intermediary_bank_country?: string;

  // --- SEPA (EUR) ---
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sepa_iban?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sepa_beneficiary_bic?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sepa_beneficiary_legal_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sepa_beneficiary_address_line_1?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sepa_beneficiary_city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sepa_beneficiary_postal_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sepa_beneficiary_country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sepa_beneficiary_address_line_2?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sepa_beneficiary_state_province_region?: string;

  // --- Shared address (US/SWIFT/SEPA beneficiary) ---
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address_line_1?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address_line_2?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  state_province_region?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  postal_code?: string;
}
