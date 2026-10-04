import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { CHAINS, type Chain } from '@/chains/chains.constants';
import { IsDecimalAmount } from '@/common/validators/is-decimal-amount.validator';
import { IsStellarAddress } from '@/common/validators/is-stellar-address.validator';
import { IsSwapAsset } from '@/common/validators/is-swap-asset.validator';

/**
 * A swap quote request: how much of which asset you want to sell (`amount` of the
 * source asset) and which asset you want to buy, on one chain.
 *
 * Stellar (the default when `chain` is omitted, exactly as before it existed):
 * priced through Horizon's strict-send path search over the DEX + AMM pools. Omit
 * an asset code (or pass "XLM"/"native") for native lumens; a non-native asset
 * needs its issuer. Solana: priced and built by Jupiter. Monad: by Kuru Flow. On
 * those two an asset is the native ticker, "native", or the mint / ERC-20 address,
 * and there is no issuer.
 */
export class QuoteSwapDto {
  @ApiPropertyOptional({
    enum: CHAINS,
    default: 'stellar',
    description:
      'The chain to swap on. Omitted means Stellar. solana → Jupiter, ' +
      'monad → Kuru Flow; both mainnet only. Swaps between chains are ' +
      '/v1/cross-chain-swaps.',
  })
  @IsOptional()
  @IsIn(CHAINS)
  chain?: Chain;

  @ApiPropertyOptional({
    description:
      'The asset being sold. Stellar: an asset code (native if omitted). ' +
      'Solana / Monad: SOL / MON, "native", or the mint / ERC-20 address.',
    example: 'XLM',
  })
  @IsOptional()
  @IsString()
  @IsSwapAsset('chain')
  sourceAssetCode?: string;

  @ApiPropertyOptional({
    description: 'Stellar only: issuer account for a non-native source asset.',
    example: 'GCRCUE2C5TBNIPYHMEP7NK5RWTT2WBSZ75CMARH7GDOHDDCQH3XANFOB',
  })
  @IsOptional()
  @IsStellarAddress()
  sourceAssetIssuer?: string;

  @ApiProperty({
    description:
      'Gross amount of the source asset to swap, in its own units (decimal; ' +
      'at most 7 places on Stellar, the token decimals elsewhere). Stellar ' +
      'deducts the platform fee from it; Solana and Monad take it from the output.',
    example: '100',
  })
  @IsString()
  @IsDecimalAmount('chain')
  amount!: string;

  @ApiProperty({
    description: 'The asset being bought, spelled as for sourceAssetCode.',
    example: 'USDC',
  })
  @IsString()
  @IsSwapAsset('chain')
  destAssetCode!: string;

  @ApiPropertyOptional({
    description:
      'Stellar only: issuer account for the destination asset (required unless it is native).',
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTR6F3DSZL5A3W4G4M4N4A5U4QY3T6',
  })
  @IsOptional()
  @IsStellarAddress()
  destAssetIssuer?: string;

  @ApiPropertyOptional({
    description:
      'Slippage tolerance in basis points (50 = 0.5%) used to derive the ' +
      'on-chain minimum received. Defaults to the service setting; capped by it.',
    example: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  slippageBps?: number;
}
