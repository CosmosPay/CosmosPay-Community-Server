import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { IsIn, IsOptional, Length, Matches } from 'class-validator';
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
      "The checkout session's token. With `address` or `txHash` it registers " +
      'what this session pays with; a report without them is informational.',
    example: 'q8V0n3cJxZr2m1bWk7yTt4uP9aLs6dEf0gHiJkLmNoQ',
  })
  @IsOptional()
  @Matches(PAYER_TOKEN_RE, {
    message: 'payerToken must be a checkout session token',
  })
  payerToken?: string;

  @ApiPropertyOptional({
    description:
      "The account the session's connected wallet pays from, on the link's " +
      "network (with `payerToken`). When it is the payment's source, the " +
      "receipt and the customer link go to this session's email.",
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  @IsOptional()
  @Length(1, 128)
  @Matches(/^[\x21-\x7e]+$/, { message: 'address must be printable' })
  address?: string;

  @ApiPropertyOptional({
    description:
      'The transaction the wallet answered when it sent the payment (with ' +
      "`payerToken`). When it is the payment's transaction, the receipt and the " +
      "customer link go to this session's email.",
    example: 'b7f1c3a2d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d',
  })
  @IsOptional()
  @Length(1, 128)
  @Matches(/^[\x21-\x7e]+$/, { message: 'txHash must be printable' })
  txHash?: string;
}
