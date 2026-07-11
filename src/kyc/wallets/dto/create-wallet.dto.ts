import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import {
  BLINDPAY_NETWORKS,
  type BlindpayNetwork,
} from '../../../blindpay/blindpay.constants';

/**
 * Registers a blockchain wallet for a receiver.
 *
 * Two flows:
 *  - Account-abstraction / non-secure: provide `address` directly.
 *  - Secure (EOA): GET `.../wallets/sign-message`, sign it in the customer's
 *    wallet, then create with `signature_tx_hash` (no raw address).
 */
export class CreateWalletDto {
  @ApiProperty({ example: 'Primary wallet' })
  @IsString()
  name!: string;

  @ApiProperty({ enum: BLINDPAY_NETWORKS, example: 'stellar' })
  @IsIn(BLINDPAY_NETWORKS)
  network!: BlindpayNetwork;

  @ApiPropertyOptional({
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
    description: 'Wallet address (account-abstraction / non-secure flow).',
  })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({
    description: 'Signed sign-message tx hash (secure EOA flow).',
  })
  @IsOptional()
  @IsString()
  signature_tx_hash?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_account_abstraction?: boolean;
}
