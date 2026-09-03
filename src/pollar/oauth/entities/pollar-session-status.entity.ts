import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The poll response, for a wallet with no addressable redirect URI: it opens
 * the authorization URL in the system browser and asks the bridge whether the
 * user came back yet. The `code` appears exactly once, when `status` first
 * reads `authorized`.
 */
export class PollarSessionStatusEntity {
  @ApiProperty({
    enum: [
      'pending',
      'authorized',
      'exchanging',
      'consumed',
      'failed',
      'expired',
    ],
    description:
      '`pending` — waiting for the user. `authorized` — the code is in this ' +
      'response. `exchanging` — a redemption is in flight. `consumed` — done. ' +
      '`failed` / `expired` — terminal, start a new handshake.',
    example: 'authorized',
  })
  status!: string;

  @ApiProperty({ example: 'q1x8Zt0kM3nR7vJ2bL5wY9cF4dH6sP0aE8gT1uI3oK' })
  state!: string;

  @ApiPropertyOptional({
    description:
      'The single-use bridge code, present only while the status is ' +
      '`authorized` and only until it expires. Redeem it at POST ' +
      '/v1/pollar/oauth/token.',
  })
  code?: string;

  @ApiPropertyOptional({
    description: 'When the code stops being redeemable.',
    example: '2026-09-02T12:02:00.000Z',
  })
  code_expires_at?: Date | null;

  @ApiPropertyOptional({
    description: "Pollar's own error code when the handshake ended badly.",
    example: 'EXPIRED_CLIENT_ID',
  })
  error_code?: string | null;
}
