import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/**
 * Executes an onramp from a previously created payin quote. The response carries
 * the payment instructions the payer must follow to fund the payin.
 *
 * Note: BlindPay's payin execution endpoint is `/payins/evm` for every
 * destination network (the chain is fixed by the quote's wallet, not the route),
 * so unlike payouts there is no chain selector here.
 */
@ApiSchema({
  description:
    'Executes a payin quote; the answer carries the instructions the payer follows to fund the payin.',
})
export class CreatePayinDto {
  @ApiProperty({
    example: 'pq_000000000000',
    description: 'The id returned by POST /v1/onramp/quotes.',
  })
  @IsString()
  payin_quote_id!: string;
}
