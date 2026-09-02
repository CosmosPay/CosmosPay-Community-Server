import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** What a wallet gets back when it opens a bridge handshake. */
export class PollarAuthorizationEntity {
  @ApiProperty({
    description:
      'Opaque handle for this handshake. Echoed back on the redirect and used ' +
      'to poll. Correlate on it — the bridge issues no other identifier.',
    example: 'q1x8Zt0kM3nR7vJ2bL5wY9cF4dH6sP0aE8gT1uI3oK',
  })
  state!: string;

  @ApiProperty({
    description:
      "Send the user here. It is Pollar's hosted OAuth entry point with the " +
      "api_key, client_session_id and the bridge's own callback already " +
      'assembled — the wallet opens it and touches nothing else.',
    example:
      'https://sdk.api.pollar.xyz/v2/auth/google?api_key=pub_testnet_…&client_session_id=…&redirect_uri=…',
  })
  authorization_url!: string;

  @ApiProperty({ enum: ['google', 'github'], example: 'google' })
  provider!: string;

  @ApiPropertyOptional({
    description:
      'Where the code will be delivered, or null when this handshake is in ' +
      'poll mode and the wallet must read it back from the bridge.',
    example: 'cosmospay://auth/callback',
  })
  redirect_uri!: string | null;

  @ApiProperty({
    description:
      'When the handshake stops being redeemable. The user has until then to ' +
      'finish the consent screen.',
    example: '2026-09-02T12:05:00.000Z',
  })
  expires_at!: Date;
}
