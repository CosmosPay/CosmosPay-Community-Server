import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { QueryPublicKeyDto } from '@/public-key/dto/query-public-key.dto';
import { PublicKeyEntity } from '@/public-key/entities/public-key.entity';
import { PUBLIC_KEY_MAX_AGE_S } from '@/public-key/public-key.constants';
import { PublicKeyService } from '@/public-key/public-key.service';

/**
 * Where a wallet with no account gets the shared public key.
 *
 * `@Public()` because the caller by definition holds no key yet. It used to be
 * served by the developer platform, which put the platform in front of every
 * anonymous wallet's first call; it is served here so everything a wallet does
 * goes through the gateway alone.
 *
 * Handing out a credential from an unauthenticated route is safe for this one
 * credential only: it is compiled into an open-source wallet, and
 * `PublicKeyGuard` confines it to the handlers marked `@AllowPublicKey`.
 * Serving it (rather than only compiling it in) is what makes rotation possible
 * without an app-store release.
 */
@ApiTags('public-key')
@Controller({ path: 'public-key', version: '1' })
export class PublicKeyController {
  constructor(private readonly publicKey: PublicKeyService) {}

  @Get()
  @Public()
  @Header('Cache-Control', `public, max-age=${PUBLIC_KEY_MAX_AGE_S}`)
  @ApiOperation({ summary: 'The shared public API key for an environment' })
  @ApiOkResponse({ type: PublicKeyEntity })
  @ApiErrorResponse({
    status: 503,
    codes: [ApiErrorCode.Misconfigured],
    examples: {
      [ApiErrorCode.Misconfigured]: {
        message:
          'No public key is published for the prod environment: set PUBLIC_API_KEY_PROD.',
        path: '/v1/public-key',
      },
    },
  })
  get(@Query() query: QueryPublicKeyDto): PublicKeyEntity {
    return { env: query.env, apiKey: this.publicKey.get(query.env) };
  }
}
