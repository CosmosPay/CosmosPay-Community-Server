import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PollarWalletEntity } from '@/pollar/oauth/entities/pollar-session.entity';

/** What Pollar vouches for about an access token it minted. */
export class PollarTokenClaimsEntity {
  @ApiProperty({ example: 'usr_01J8Z3K2M4N5P6Q7R8S9T0' })
  user_id!: string;

  @ApiProperty({
    description: 'The Pollar application the token was minted for.',
    example: 'app_01J8Z3K2M4N5P6Q7R8S9T0',
  })
  application_id!: string;

  @ApiProperty({ description: 'Epoch milliseconds.', example: 1788350400000 })
  expires_at!: number;

  @ApiPropertyOptional({ example: 'testnet' })
  network?: string;

  @ApiPropertyOptional({ example: 'google' })
  auth_provider?: string;

  @ApiPropertyOptional({ type: PollarWalletEntity })
  wallet?: PollarWalletEntity;
}
