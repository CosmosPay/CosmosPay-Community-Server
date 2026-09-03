import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsString, Matches } from 'class-validator';

/** base64url encoding of a P-256 coordinate: 32 bytes -> 43 characters. */
const P256_COORDINATE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The public half of the wallet's DPoP keypair (RFC 9449), in JWK form.
 *
 * Supplying it binds the tokens Pollar mints to that key (`cnf.jkt`): every
 * later call must carry a proof signed by the private half, so a stolen access
 * token is inert on its own. It also means the bridge can no longer act for the
 * wallet — it does not hold the private key — which is why `POST
 * /v1/pollar/oauth/refresh` and `/logout` refuse a DPoP-bound session and tell
 * the wallet to call Pollar directly.
 *
 * Pollar accepts exactly ES256 (`EC` / `P-256`), so the algorithm is not a
 * choice and is validated as a constant.
 */
export class DpopJwkDto {
  @ApiProperty({ example: 'EC', enum: ['EC'] })
  @Equals('EC')
  kty!: 'EC';

  @ApiProperty({ example: 'P-256', enum: ['P-256'] })
  @Equals('P-256')
  crv!: 'P-256';

  @ApiProperty({
    description: 'base64url of the 32-byte x coordinate.',
    example: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  })
  @IsString()
  @Matches(P256_COORDINATE, {
    message: 'x must be a base64url P-256 coordinate',
  })
  x!: string;

  @ApiProperty({
    description: 'base64url of the 32-byte y coordinate.',
    example: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  })
  @IsString()
  @Matches(P256_COORDINATE, {
    message: 'y must be a base64url P-256 coordinate',
  })
  y!: string;
}
