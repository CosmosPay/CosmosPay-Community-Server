import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { CHAINS, type Chain } from '@/chains/chains.constants';
import { IsChainAddress } from '@/common/validators/is-chain-address.validator';
import { IsDecimalAmount } from '@/common/validators/is-decimal-amount.validator';

/**
 * A cross-chain swap request: sell `amount` of `originAsset` on `originChain`,
 * receive `destinationAsset` on `destinationChain` at `recipient`. NEAR Intents
 * prices it; a failed swap refunds `refundTo` on the origin chain.
 *
 * Both legs on one chain is not a cross-chain swap: `POST /v1/swaps` settles it
 * on that chain's own venue (the Stellar DEX, Jupiter, Kuru Flow).
 */
export class QuoteCrossChainSwapDto {
  @ApiProperty({ enum: CHAINS, example: 'stellar' })
  @IsIn(CHAINS)
  originChain!: Chain;

  @ApiProperty({
    description:
      'The asset sold: the native ticker (XLM, SOL, MON), a symbol listed once ' +
      'on the chain (USDC), a contract (SPL mint, ERC-20 address, Stellar ' +
      'issuer) or Stellar CODE:ISSUER. See GET /v1/cross-chain-swaps/assets.',
    example: 'XLM',
  })
  @IsString()
  @Length(1, 128)
  originAsset!: string;

  @ApiProperty({ enum: CHAINS, example: 'solana' })
  @IsIn(CHAINS)
  destinationChain!: Chain;

  @ApiProperty({
    description: 'The asset bought, spelled as for originAsset.',
    example: 'USDC',
  })
  @IsString()
  @Length(1, 128)
  destinationAsset!: string;

  @ApiProperty({
    description:
      'Gross amount of the origin asset, in its own units (decimal). The plan ' +
      'commission is taken out of it; the quoted output is net of it.',
    example: '100',
  })
  @IsDecimalAmount('originChain')
  amount!: string;

  @ApiProperty({
    description: 'Who receives the output, on destinationChain.',
    example: '13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK',
  })
  @IsChainAddress('destinationChain')
  recipient!: string;

  @ApiProperty({
    description:
      'Where a failed or late deposit is refunded, on originChain — normally the paying wallet.',
    example: 'GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG',
  })
  @IsChainAddress('originChain')
  refundTo!: string;

  @ApiPropertyOptional({
    description:
      'Slippage tolerance in basis points (100 = 1%). Below the resulting ' +
      'minimum, NEAR Intents refunds instead of filling. Defaults to the ' +
      'service setting; capped by it.',
    example: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  slippageBps?: number;
}
