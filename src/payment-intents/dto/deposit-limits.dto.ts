import { ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  PAYMENT_DEPOSIT_LINK_BUDGET,
  PAYMENT_DEPOSIT_LINK_BUDGET_CEILING,
  PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT,
  PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT_CEILING,
} from '@/payment-intents/payment-intents.constants';

/**
 * A merchant's own limits on payments from another network for one link,
 * raised from the defaults up to the ceilings this service fixes. Omitted
 * fields keep the default.
 */
@ApiSchema({
  description:
    'Limits on payments from another network for this link: how many deposit ' +
    'addresses one payer may have open, and how many new ones the link takes ' +
    'every five minutes. Raise them for a link many people pay at once.',
})
export class DepositLimitsDto {
  @ApiPropertyOptional({
    minimum: PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT,
    maximum: PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT_CEILING,
    default: PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT,
    description:
      'Open deposit addresses one payer (one client address) may have on the link.',
    example: 4,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT)
  @Max(PAYMENT_DEPOSIT_MAX_OPEN_PER_CLIENT_CEILING)
  perPayer?: number;

  @ApiPropertyOptional({
    minimum: PAYMENT_DEPOSIT_LINK_BUDGET,
    maximum: PAYMENT_DEPOSIT_LINK_BUDGET_CEILING,
    default: PAYMENT_DEPOSIT_LINK_BUDGET,
    description:
      'New deposit addresses the link takes every five minutes, from all payers.',
    example: 60,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(PAYMENT_DEPOSIT_LINK_BUDGET)
  @Max(PAYMENT_DEPOSIT_LINK_BUDGET_CEILING)
  perWindow?: number;
}
