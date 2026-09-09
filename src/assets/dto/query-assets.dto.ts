import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBooleanString, IsIn, IsOptional } from 'class-validator';

/**
 * Filters for the asset catalog.
 *
 * `network` is a query parameter here and NOT derived from the API key's
 * environment, unlike every other endpoint in this service. The catalog is public
 * reference data with no tenant in it, and the two callers that matter both need
 * the other network's list: the wallet warms both so switching networks does not
 * blank the token picker, and the dashboard renders pickers for whichever network
 * a form targets. Defaulting to the key's environment would have made "show me
 * testnet assets" impossible to ask with a production key.
 */
export class QueryAssetsDto {
  @ApiPropertyOptional({
    enum: ['public', 'testnet'],
    default: 'public',
    description: 'Which Stellar network to list.',
  })
  @IsOptional()
  @IsIn(['public', 'testnet'])
  network: 'public' | 'testnet' = 'public';

  @ApiPropertyOptional({
    description:
      'Return only issuer-verified entries. Omit to get the whole catalog, ' +
      'verified and not, and render the difference.',
  })
  @IsOptional()
  @IsBooleanString()
  verified?: string;
}
