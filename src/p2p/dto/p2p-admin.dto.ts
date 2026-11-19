import { IsIn, IsOptional, Matches } from 'class-validator';
import { AdminPageQueryDto } from '@/admin/dto/admin-list.query.dto';

/**
 * The platform console's P2P requests. Excluded from the OpenAPI contract with
 * the rest of `/v1/admin`.
 */

export class AdminP2pDisputesQueryDto extends AdminPageQueryDto {
  @IsOptional()
  @IsIn(['public', 'testnet'])
  tier?: 'public' | 'testnet';
}

export class AdminP2pResolutionDto {
  /** Base units of the order's amount that go to the buyer (fees taken from it); the rest goes back to the seller. */
  @Matches(/^(0|[1-9]\d{0,37})$/, {
    message: 'toBuyer must be a non-negative integer in base units',
  })
  toBuyer!: string;

  /** Base units of the buyer's bond that go to the seller; the rest back to the buyer. */
  @IsOptional()
  @Matches(/^(0|[1-9]\d{0,37})$/, {
    message: 'bondToSeller must be a non-negative integer in base units',
  })
  bondToSeller?: string;
}

export class AdminP2pMerchantDto {
  @IsIn(['ACTIVE', 'SUSPENDED'])
  merchantStatus!: 'ACTIVE' | 'SUSPENDED';
}
