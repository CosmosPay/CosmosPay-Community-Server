import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * Attaches a compliance document to a payout (e.g. an invoice or proof of the
 * underlying transaction). File ids/urls come from POST /v1/kyc/upload.
 */
@ApiSchema({
  description:
    'A compliance document backing a payout (an invoice, for example), forwarded to BlindPay.',
})
export class PayoutDocumentDto {
  @ApiProperty({
    example: 'invoice',
    description: 'Kind of document (for example `invoice`).',
  })
  @IsString()
  transaction_document_type!: string;

  @ApiProperty({
    example: 'INV-2026-001',
    description:
      'Identifier of the document itself, such as the invoice number.',
  })
  @IsString()
  transaction_document_id!: string;

  @ApiProperty({ description: 'file_url from POST /v1/kyc/upload' })
  @IsString()
  transaction_document_file!: string;

  @ApiPropertyOptional({
    description:
      'Free-text description of the document, forwarded to BlindPay.',
  })
  @IsOptional()
  @IsString()
  description?: string;
}
