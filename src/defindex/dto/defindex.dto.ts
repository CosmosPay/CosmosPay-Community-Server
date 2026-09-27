import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateBy,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StrKey } from '@stellar/stellar-sdk';
import { DEFINDEX_MAX_AMOUNT } from '@/defindex/defindex.constants';
import { IsStellarAddress } from '@/common/validators/is-stellar-address.validator';

const UINT_RE = /^(0|[1-9]\d*)$/;

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
  @ApiProperty()
  @IsStellarContract()
  vault!: string;
}

export class DefindexBalanceQueryDto {
  @ApiProperty()
  @IsStellarAddress()
  account!: string;
}

export class DefindexDepositDto {
  @ApiProperty({ type: [String], example: ['10000000'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @Matches(UINT_RE, { each: true })
  amounts!: string[];

  @ApiProperty()
  @IsStellarAddress()
  caller!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  invest?: boolean;

  @ApiPropertyOptional({ default: 100, minimum: 0, maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  slippageBps?: number;
}

export class DefindexWithdrawDto {
  @ApiProperty({ example: '1000000' })
  @Matches(UINT_RE)
  shares!: string;

  @ApiProperty()
  @IsStellarAddress()
  caller!: string;

  @ApiPropertyOptional({ default: 100, minimum: 0, maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  slippageBps?: number;
}

export class DefindexSubmitDto {
  @ApiProperty()
  @IsString()
  xdr!: string;
}

export function defindexAmount(value: string): number {
  const amount = Number(value);
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    amount > DEFINDEX_MAX_AMOUNT
  ) {
    throw new Error(
      'Amount exceeds the safe integer range accepted by the DeFindex SDK',
    );
  }
  return amount;
}
