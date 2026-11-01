import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
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
}
