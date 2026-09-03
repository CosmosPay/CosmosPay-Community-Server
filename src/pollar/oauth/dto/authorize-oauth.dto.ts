import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  POLLAR_OAUTH_PROVIDERS,
  POLLAR_PKCE_METHOD,
  type PollarOauthProvider,
} from '@/pollar/pollar.constants';
import { DpopJwkDto } from '@/pollar/oauth/dto/dpop-jwk.dto';

/** Opens a bridge handshake and returns the URL the wallet should send the user to. */
export class AuthorizeOauthDto {
  @ApiProperty({
    enum: POLLAR_OAUTH_PROVIDERS,
    example: 'google',
    description: 'Hosted OAuth provider. Pollar owns the app registration.',
  })
  @IsIn(POLLAR_OAUTH_PROVIDERS)
  provider!: PollarOauthProvider;

  @ApiPropertyOptional({
    example: 'cosmospay://auth/callback',
    description:
      'Where the bridge delivers the single-use code, as `?code=…&state=…`. ' +
      'Must be registered for this consumer in POLLAR_REDIRECT_URI_WHITELIST. ' +
      'Omit it to use the poll flow (GET /v1/pollar/oauth/sessions/{state}), ' +
      'which is the right shape for a wallet that cannot be addressed by URL.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  redirect_uri?: string;

  @ApiPropertyOptional({
    description:
      'PKCE challenge (RFC 7636): BASE64URL(SHA256(code_verifier)). Optional, ' +
      'but once supplied the matching `code_verifier` is required to redeem. ' +
      'Bind the code to the wallet that asked for it — a code that leaks out of ' +
      'a browser or a log is then useless on its own.',
    example: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  })
  @IsOptional()
  @IsString()
  @Length(43, 128)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'code_challenge must be base64url (RFC 7636)',
  })
  code_challenge?: string;

  @ApiPropertyOptional({
    enum: [POLLAR_PKCE_METHOD],
    default: POLLAR_PKCE_METHOD,
    description: 'S256 only. `plain` offers no protection across a redirect.',
  })
  @IsOptional()
  @IsIn([POLLAR_PKCE_METHOD])
  code_challenge_method?: typeof POLLAR_PKCE_METHOD;

  @ApiPropertyOptional({
    type: DpopJwkDto,
    description:
      "The wallet's DPoP public key. When present, Pollar binds the minted " +
      'tokens to it and only the wallet can use or refresh them.',
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DpopJwkDto)
  dpop_jwk?: DpopJwkDto;

  @ApiPropertyOptional({
    example: 'Cosmos Wallet — macOS',
    description:
      "Label shown in Pollar's session list, so a user can tell this device " +
      'apart from their others when revoking.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  device_label?: string;
}
