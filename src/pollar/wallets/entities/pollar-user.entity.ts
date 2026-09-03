import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PollarWalletEntity } from '@/pollar/oauth/entities/pollar-session.entity';

/**
 * A user registered with Pollar ahead of their first login.
 *
 * Pollar documents the *result code* of these routes but not the shape of their
 * content, so this is a deliberately narrow projection of it rather than the
 * provider payload passed through: an undocumented shape relayed verbatim is one
 * we cannot promise, cannot version, and cannot stop from carrying a field we
 * never meant to publish. The fields below are the ones the caller can act on.
 */
export class PollarUserEntity {
  @ApiProperty({
    description: 'Your own id for the user, echoed back.',
    example: 'usr_7Kd2',
  })
  external_id!: string;

  @ApiProperty({
    description: "Pollar's own result code for the registration.",
    enum: ['SERVER_USER_REGISTERED', 'SERVER_USER_WALLET_CREATED'],
    example: 'SERVER_USER_REGISTERED',
  })
  code!: string;

  @ApiPropertyOptional({
    description: "Pollar's id for the user, when it reported one.",
    example: 'usr_01J8Z3K2M4N5P6Q7R8S9T0',
  })
  user_id?: string | null;

  @ApiPropertyOptional({
    type: PollarWalletEntity,
    description:
      'The provisioned wallet — only on `/users/with-wallet`, and only once ' +
      'Pollar has created it.',
  })
  wallet?: PollarWalletEntity | null;
}
