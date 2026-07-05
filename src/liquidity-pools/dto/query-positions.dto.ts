import { ApiProperty } from '@nestjs/swagger';
import { IsStellarAddress } from '../../common/validators/is-stellar-address.validator';

/** List an account's liquidity pool share positions (read from Horizon). */
export class QueryLiquidityPositionsDto {
  @ApiProperty({
    description: 'Account whose pool share trustlines to inspect.',
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  @IsStellarAddress()
  account!: string;
}
