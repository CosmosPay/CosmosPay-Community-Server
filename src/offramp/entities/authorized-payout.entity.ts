import { ApiProperty } from '@nestjs/swagger';

/**
 * BlindPay's authorize answer for a Stellar/Solana payout, passed through, with
 * the unsigned transaction under one stable field. BlindPay names it
 * `transaction_hash` (it is the XDR to sign, not a hash); the other keys it sends
 * are returned as is.
 */
export class AuthorizedPayoutEntity {
  @ApiProperty({
    example: 'AAAAAgAAAAB…',
    description:
      'The unsigned transaction the customer signs before `POST /v1/offramp/payouts`. Empty when BlindPay returned none.',
  })
  unsigned_transaction!: string;
}
