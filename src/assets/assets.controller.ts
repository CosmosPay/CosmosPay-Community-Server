import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowPublicKey } from '@/common/decorators/allow-public-key.decorator';
import { QueryAssetsDto } from '@/assets/dto/query-assets.dto';
import { AssetListEntity } from '@/assets/entities/asset.entity';
import { AssetsService } from '@/assets/assets.service';
import { ASSET_REGISTRY_MAX_AGE_S } from '@/assets/assets.constants';

/**
 * The public asset catalog: which (code, issuer) pairs this platform vouches for.
 *
 * Note what is missing — a `@RequirePermissions`. The catalog contains no tenant
 * data and is identical for every caller, so gating it behind a scope would only
 * mean that every key minted before the scope existed reads an empty token picker
 * until someone rotates it. ApisixGuard still requires an authenticated consumer,
 * so this is reachable with any valid key, the shared public one included; the
 * dev-platform mirrors it unauthenticated for callers that hold no key at all.
 */
@ApiTags('assets')
@Controller({ path: 'assets', version: '1' })
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @AllowPublicKey()
  // Cacheable by anything in the path — the response is a pure function of the
  // query and carries no consumer identity, which is exactly what `public`
  // asserts to a shared cache.
  @Header('Cache-Control', `public, max-age=${ASSET_REGISTRY_MAX_AGE_S}`)
  @ApiOperation({
    summary: 'Known Stellar assets per network, with issuer identity',
    description:
      'The wallet ships a bundled copy of this list and prefers whichever of ' +
      'the two carries the higher `version`, so a client that cannot reach ' +
      'this endpoint still resolves assets correctly — it just misses the ' +
      'newest additions.',
  })
  @ApiOkResponse({ type: AssetListEntity })
  list(@Query() query: QueryAssetsDto): AssetListEntity {
    return {
      network: query.network,
      version: this.assets.version,
      data: this.assets.list(query.network, query.verified === 'true'),
    };
  }
}
