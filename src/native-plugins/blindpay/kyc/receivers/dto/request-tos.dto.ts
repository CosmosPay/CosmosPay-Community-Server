import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { IsRedirectUrl } from '@/common/validators/is-redirect-url.validator';

/**
 * Requests a terms-of-service acceptance link for a receiver. A receiver is created
 * inactive (no ToS up front); this returns the hosted ToS URL so the end user can
 * accept and obtain the `tos_id` that {@link EnableReceiverDto} then submits to
 * activate the account. `channel: email` delivers the link by email (rate limited to
 * once per day) instead of returning it to display.
 */
@ApiSchema({
  description:
    'A request for a fresh terms-of-service link for a `pending_user` receiver.',
})
export class RequestTosDto {
  @ApiPropertyOptional({
    enum: ['code', 'email'],
    default: 'code',
    description:
      "'code' returns the hosted ToS URL to display. 'email' records an email send, allowed once per 24 hours per receiver; it sends nothing itself, so you email the returned link.",
  })
  @IsOptional()
  @IsIn(['code', 'email'])
  channel?: 'code' | 'email';

  @ApiProperty({
    example: 'https://yourapp.com/kyc/return',
    description:
      'Where BlindPay redirects after acceptance (gets ?tos_id=...). Must be https and on the consumer allow-list.',
  })
  @IsRedirectUrl()
  redirect_url!: string;
}
