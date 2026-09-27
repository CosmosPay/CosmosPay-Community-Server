import { Module } from '@nestjs/common';
import { OidcService } from '@/common/oidc/oidc.service';

/**
 * OpenID Connect verification, shared by the wallet sign-in (Authentik as the
 * identity provider) and by the recovery servers (an ID token as SEP-30's
 * external authentication). One cache per process for both.
 */
@Module({
  providers: [OidcService],
  exports: [OidcService],
})
export class OidcModule {}
