import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import {
  BLINDPAY_NETWORKS,
  type BlindpayNetwork,
} from '@/native-plugins/blindpay/blindpay.constants';

/**
 * Registers a blockchain wallet for a receiver.
 *
 * Two flows:
 *  - Account-abstraction / non-secure: provide `address` directly.
 *  - Secure (EOA): GET `.../wallets/sign-message`, sign it in the customer's
 *    wallet, then create with `signature_tx_hash` (no raw address).
 */
@ApiSchema({
  description:
    'A blockchain wallet to register for a receiver: send `address`, or the `signature_tx_hash` of the signed sign-message (secure EOA flow).',
})
export class CreateWalletDto {
  @ApiProperty({
    example: 'Primary wallet',
    description: 'A label for the wallet, forwarded to BlindPay.',
  })
  @IsString()
  name!: string;

  @ApiProperty({
    enum: BLINDPAY_NETWORKS,
    example: 'stellar',
    description:
      'BlindPay network the wallet is on (mainnets and their test networks).',
  })
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

  @ApiPropertyOptional({
    example: true,
    description: 'Whether `address` is an account-abstraction wallet.',
  })
  @IsOptional()
  @IsBoolean()
  is_account_abstraction?: boolean;
}
