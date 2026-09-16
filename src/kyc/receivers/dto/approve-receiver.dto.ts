import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { IsRedirectUrl } from '@/common/validators/is-redirect-url.validator';

/**
 * Approves a `pending_review` receiver (our owner/admin review gate). The platform
 * has reviewed the uploaded KYC data; approving sends the customer BlindPay's
 * terms-of-service link and moves the receiver to `pending_user`. `redirect_url` is
 * where BlindPay returns the customer (with `?tos_id=...`) after they accept.
 */
export class ApproveReceiverDto {
  @ApiProperty({
    example: 'https://dev.cosmospay.lat/kyc/return/org/dev/clz9xreceiver01',
    description:
      'Where BlindPay redirects the customer after they accept the terms. Must be https and on the consumer allow-list.',
  })
  @IsRedirectUrl()
  redirect_url!: string;

  /**
   * The dossier version this approval is for — `dossierVersion` as the receiver
   * read returned it.
   *
   * A review is a person reading the KYC data and then approving it, and the
   * tenant can edit that data in between: the status stays `pending_review`
   * through an edit, so without this the approval lands on whatever the payload
   * happens to be when the request arrives. Send it and a changed dossier is a
   * 409 `kyc_state_invalid` instead.
   *
   * Optional for compatibility. Omitting it approves whatever is stored at that
   * moment, which is only safe if nothing else can write to the receiver.
   */
  @ApiPropertyOptional({
    example: 3,
    description:
      "The receiver's `dossierVersion` as you read it. A 409 `kyc_state_invalid` if the KYC data changed since — re-read, review again, approve that version. Omitted approves whatever is stored now.",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expected_version?: number;
}
