import { ApiProperty } from '@nestjs/swagger';
import { IsStellarAddress } from '@/common/validators/is-stellar-address.validator';

export class SelectPrivateQuoteDto {
  @ApiProperty({
    description: 'Bidder/provider address from the revealed round.',
  })
  @IsStellarAddress()
  provider!: string;
}
