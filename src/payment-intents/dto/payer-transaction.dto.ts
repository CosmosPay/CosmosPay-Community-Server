import { ApiProperty } from '@nestjs/swagger';
import { IsStellarAddress } from '@/common/validators/is-stellar-address.validator';

/** The payer of a payment link that builds its envelope for its payer. */
export class PayerTransactionDto {
  @ApiProperty({
    description:
      'The Stellar account that will pay and sign: the envelope is built on ' +
      'its sequence number, so it must exist on the link’s network.',
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  @IsStellarAddress()
  account!: string;
}
