import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/**
 * Activates an inactive receiver: submits the accepted terms-of-service id (from the
 * redirect of the ToS flow) so the receiver is finally created at BlindPay with the
 * stored registration payload and moves out of the 'inactive' state.
 */
export class EnableReceiverDto {
  @ApiProperty({
    example: 'to_a1b2c3d4e5f6g7h',
    description:
      'Accepted terms-of-service id (the ?tos_id=... from the ToS redirect).',
  })
  @IsString()
  tos_id!: string;
}
