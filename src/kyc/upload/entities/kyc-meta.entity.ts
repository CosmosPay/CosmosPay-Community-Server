import { ApiProperty } from '@nestjs/swagger';

/** Where an uploaded KYC document now lives, for use in a receiver's fields. */
export class KycUploadEntity {
  @ApiProperty({
    description:
      "The provider's URL for the file. Pass it as a document field when creating or updating a receiver.",
    example: 'https://files.blindpay.com/uploads/onboarding/doc_example.pdf',
  })
  file_url!: string;
}

/** The hosted page where the customer accepts the terms of service. */
export class KycTermsOfServiceEntity {
  @ApiProperty({
    description:
      'Open it in a browser; the customer returns to `redirect_url` with a `tos_id`.',
    example:
      'https://app.blindpay.com/e/terms-of-service?session_token=tos_example',
  })
  url!: string;
}
