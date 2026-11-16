import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { PAYER_TOKEN_RE } from '@/payment-intents/dto/payment-deposit.dto';
import {
  CHECKOUT_EVENTS,
  type CheckoutEvent,
} from '@/payment-intents/payment-intents.constants';

/** What the payer did with a wallet, as the hosted checkout saw it. */
@ApiSchema({
  description:
    'What the payer did with a wallet, as the hosted checkout page reports it. Informational: the intent status changes only on the chain.',
})
export class CheckoutEventDto {
  @ApiProperty({
    enum: CHECKOUT_EVENTS,
    description:
      '`walletOpened`: the payer opened a wallet from the page (the wallet link, ' +
      'the web wallet, the extension, Freighter). `walletClosed`: the wallet came ' +
      'back without paying (it declined, or the page was shown again first). ' +
      '`sent`: the page saw the wallet send the payment.',
    example: 'walletOpened',
  })
  @IsIn(CHECKOUT_EVENTS)
  event!: CheckoutEvent;

  @ApiPropertyOptional({
    description:
      "The checkout session's token: a `sent` it reports makes that session's " +
      'email the one the receipt of a payment with the link itself goes to.',
    example: 'q8V0n3cJxZr2m1bWk7yTt4uP9aLs6dEf0gHiJkLmNoQ',
  })
  @IsOptional()
  @Matches(PAYER_TOKEN_RE, {
    message: 'payerToken must be a checkout session token',
  })
  payerToken?: string;
}
