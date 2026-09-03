import { ApiProperty } from '@nestjs/swagger';
import { IsStellarAddress } from '@/common/validators/is-stellar-address.validator';

/**
 * Funds a Pollar wallet's XLM reserve on-chain — the Deferred funding mode,
 * where an account is only created once your own business event says the user
 * has earned one (KYC approved, first deposit, whatever the rule is).
 */
export class ActivateWalletDto {
  @ApiProperty({
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    description: "The wallet's Stellar public key, as the session reported it.",
  })
  @IsStellarAddress()
  public_key!: string;
}
