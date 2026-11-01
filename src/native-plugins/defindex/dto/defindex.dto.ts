import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { StrKey } from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  DEFINDEX_MAX_AMOUNT,
  DEFINDEX_MAX_VAULT_ASSETS,
} from '@/native-plugins/defindex/defindex.constants';
import { IsStellarAddress } from '@/common/validators/is-stellar-address.validator';

const UINT_RE = /^(0|[1-9]\d*)$/;

/** Whether `value` is a decimal integer string DeFindex can take exactly. */
function isDefindexAmount(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    UINT_RE.test(value) &&
    BigInt(value) <= DEFINDEX_MAX_AMOUNT
  );
}

/**
 * An amount in the vault asset's minor units: a decimal integer no larger than
 * {@link DEFINDEX_MAX_AMOUNT}. Checked by the validation pipe, so an oversized
 * amount is a `400 validation_failed` and DeFindex is never called with it.
 */
const IsDefindexAmount = (each = false) =>
  ValidateBy(
    {
      name: 'isDefindexAmount',
      validator: {
        validate: (value: unknown) => isDefindexAmount(value),
        defaultMessage: (args) =>
          `${args?.property ?? 'amount'} must ${each ? 'each ' : ''}be a ` +
          `non-negative integer string no larger than ${DEFINDEX_MAX_AMOUNT}`,
      },
    },
    { each },
  );

const IsStellarContract = () =>
  ValidateBy({
    name: 'isStellarContract',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && StrKey.isValidContract(value),
      defaultMessage: () =>
        'vault must be a valid Stellar contract address (C...)',
    },
  });

export class DefindexVaultParamsDto {
  @ApiProperty({ description: "The vault's contract address (C...)." })
  @IsStellarContract()
  vault!: string;
}

export class DefindexBalanceQueryDto {
  @ApiProperty({
    description:
      'The Stellar account (G...) whose shares and their underlying value are read.',
  })
  @IsStellarAddress()
  account!: string;
}

@ApiSchema({
  description:
    'Request to build an unsigned deposit into a DeFindex vault for `caller`, ' +
    'to sign unchanged and send to `POST /v1/defindex/submit`.',
})
export class DefindexDepositDto {
  @ApiProperty({
    type: [String],
    example: ['10000000'],
    description:
      "One per vault asset, in the asset's minor units: non-negative integer " +
      `strings no larger than ${DEFINDEX_MAX_AMOUNT}.`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(DEFINDEX_MAX_VAULT_ASSETS)
  @IsDefindexAmount(true)
  amounts!: string[];

  @ApiProperty({
    description:
      'The Stellar account (G...) that deposits: the source of the built ' +
      'transaction, and the account that signs it.',
  })
  @IsStellarAddress()
  caller!: string;

  @ApiPropertyOptional({
    default: true,
    description:
      "Forwarded to DeFindex as the `invest` argument of the vault's `deposit` call.",
  })
  @IsOptional()
  @IsBoolean()
  invest?: boolean;

  @ApiPropertyOptional({
    default: 100,
    minimum: 0,
    maximum: 10000,
    description:
      "Slippage tolerance in basis points (100 = 1%): how far below `amounts` the deposit's minimum amounts may be.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  slippageBps?: number;
}

@ApiSchema({
  description:
    'Request to build an unsigned withdrawal from a DeFindex vault that burns ' +
    "`caller`'s shares for the vault's underlying assets, to sign unchanged and " +
    'send to `POST /v1/defindex/submit`.',
})
export class DefindexWithdrawDto {
  @ApiProperty({
    example: '1000000',
    description: `Vault shares to burn: a non-negative integer string no larger than ${DEFINDEX_MAX_AMOUNT}.`,
  })
  @IsDefindexAmount()
  shares!: string;

  @ApiProperty({
    description:
      'The Stellar account (G...) whose shares are burned: the source of the ' +
      'built transaction, and the account that signs it.',
  })
  @IsStellarAddress()
  caller!: string;

  @ApiPropertyOptional({
    default: 100,
    minimum: 0,
    maximum: 10000,
    description:
      "Slippage tolerance in basis points (100 = 1%), passed to DeFindex for the withdrawal's minimum outputs.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  slippageBps?: number;
}

@ApiSchema({
  description:
    'A signed DeFindex transaction to relay: one that a deposit or withdraw ' +
    'build on this service returned to the same API key.',
})
export class DefindexSubmitDto {
  @ApiProperty({
    description:
      'The transaction a DeFindex build on this service returned, signed by ' +
      '`caller` (base64 envelope XDR).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  xdr!: string;
}

/**
 * The SDK's number for a validated amount string. The DTOs already refuse an
 * amount past {@link DEFINDEX_MAX_AMOUNT}; this is the same rule at the call,
 * as a 400 rather than a provider error, so a caller that skips the pipe still
 * never reaches DeFindex with a rounded number.
 */
export function defindexAmount(value: string): number {
  if (!isDefindexAmount(value)) {
    throw ApiError.badRequest(
      ApiErrorCode.InvalidAmount,
      `Amount ${value} is not an integer DeFindex can take exactly (at most ${DEFINDEX_MAX_AMOUNT})`,
    );
  }
  return Number(value);
}
