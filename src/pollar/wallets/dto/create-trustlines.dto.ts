import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { IsStellarAddress } from '@/common/validators/is-stellar-address.validator';

/** One asset to trust: a code plus the account that issues it. */
export class TrustlineAssetDto {
  @ApiProperty({ example: 'USDC' })
  @IsString()
  @Matches(/^[A-Za-z0-9]{1,12}$/, {
    message: 'code must be 1-12 alphanumeric characters (SEP-11 alphanum4/12)',
  })
  code!: string;

  @ApiProperty({
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  })
  @IsStellarAddress()
  issuer!: string;
}

/** Enables explicit trustlines on a funded Pollar wallet. */
export class CreateTrustlinesDto {
  @ApiProperty({
    type: [TrustlineAssetDto],
    description:
      "Assets to trust. Each costs 0.5 XLM of the wallet's reserve, paid by " +
      'your Pollar funding wallet.',
  })
  @IsArray()
  @ArrayNotEmpty()
  // Each entry is a reserve-consuming on-chain operation, so the batch is
  // bounded rather than "whatever fits in a request body".
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => TrustlineAssetDto)
  assets!: TrustlineAssetDto[];
}
