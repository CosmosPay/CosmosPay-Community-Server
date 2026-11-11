import { ApiProperty, ApiSchema } from '@nestjs/swagger';

/** Where an uploaded KYC document now lives, for use in a receiver's fields. */
@ApiSchema({
  description:
    "A KYC document stored at the fiat partner, referenced by its URL in a receiver's `*_file` fields.",
})
export class KycUploadEntity {
  @ApiProperty({
    description:
      "The provider's URL for the file. Pass it as a document field when creating or updating a receiver.",
    example: 'https://files.partner.example/uploads/onboarding/doc_example.pdf',
  })
  file_url!: string;
}

/** The hosted page where the customer accepts the terms of service. */
@ApiSchema({
  description:
    "The hosted page where the customer accepts the fiat partner's terms of service.",
})
export class KycTermsOfServiceEntity {
  @ApiProperty({
    description:
      'Open it in a browser; the customer returns to `redirect_url` with a `tos_id`.',
    example:
      'https://partner.example/terms-of-service?session_token=tos_example',
  })
  url!: string;
}
