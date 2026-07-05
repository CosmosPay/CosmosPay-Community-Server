import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

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
      'Where BlindPay redirects the customer after they accept the terms.',
  })
  @IsString()
  redirect_url!: string;
}
