import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * Attaches a compliance document to a payout (e.g. an invoice or proof of the
 * underlying transaction). File ids/urls come from POST /v1/kyc/upload.
 */
export class PayoutDocumentDto {
  @ApiProperty({ example: 'invoice' })
  @IsString()
  transaction_document_type!: string;

  @ApiProperty({ example: 'INV-2026-001' })
  @IsString()
  transaction_document_id!: string;

  @ApiProperty({ description: 'file_url from POST /v1/kyc/upload' })
  @IsString()
  transaction_document_file!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}
