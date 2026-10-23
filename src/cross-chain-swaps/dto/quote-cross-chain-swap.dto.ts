import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { SWAP_CHAINS, type SwapChain } from '@/chains/chains.constants';
import { IsSwapChainAddress } from '@/common/validators/is-chain-address.validator';
import { IsSwapDecimalAmount } from '@/common/validators/is-decimal-amount.validator';

/**
 * A cross-chain swap request: sell `amount` of `originAsset` on `originChain`,
 * receive `destinationAsset` on `destinationChain` at `recipient`. NEAR Intents
 * prices it; a failed swap refunds `refundTo` on the origin chain.
 *
 * Both legs on Stellar, Solana or Monad is not a cross-chain swap:
 * `POST /v1/swaps` settles it on that chain's own venue (the Stellar DEX,
 * Jupiter, Kuru Flow). Ethereum, Arbitrum and Base have no venue here, so a
 * pair on one of them is settled by NEAR Intents like any other. On Solana
 * and Monad a client whose venue call failed may ask for NEAR Intents
 * instead with `venueFallback`.
 */
export class QuoteCrossChainSwapDto {
  @ApiProperty({
    enum: SWAP_CHAINS,
    example: 'stellar',
    description:
      'The chain the payer deposits on. A pair with both legs on stellar, ' +
      'solana or monad is refused here — POST /v1/swaps settles it on that ' +
      "chain's own venue; one on ethereum, arbitrum or base is settled by " +
      'NEAR Intents.',
  })
  @IsIn(SWAP_CHAINS)
  originChain!: SwapChain;

  @ApiProperty({
    description:
      'The asset sold: the native ticker (XLM, SOL, MON, ETH, BTC) or ' +
      '"native", a symbol listed once on the chain (USDC), a contract (SPL ' +
      'mint, ERC-20 address, Stellar issuer) or Stellar CODE:ISSUER. See ' +
      'GET /v1/cross-chain-swaps/assets.',
    example: 'XLM',
  })
  @IsString()
  @Length(1, 128)
  originAsset!: string;

  @ApiProperty({
    enum: SWAP_CHAINS,
    example: 'solana',
    description: 'The chain the recipient is paid on.',
  })
  @IsIn(SWAP_CHAINS)
  destinationChain!: SwapChain;

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
  @IsSwapDecimalAmount('originChain')
  amount!: string;

  @ApiProperty({
    description:
      'Who receives the output, on destinationChain: a Stellar G… account, a ' +
      'Solana address, an EVM 0x address (Monad, Ethereum, Arbitrum, Base) or ' +
      'a Bitcoin mainnet address (bc1q…, bc1p…, 1…, 3…).',
    example: '13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK',
  })
  @IsSwapChainAddress('destinationChain')
  recipient!: string;

  @ApiProperty({
    description:
      'Where a failed or late deposit is refunded, on originChain — normally the paying wallet.',
    example: 'GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG',
  })
  @IsSwapChainAddress('originChain')
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

  @ApiPropertyOptional({
    description:
      'Settle a pair that stays on Solana or Monad through NEAR Intents, ' +
      "because that chain's own venue (Jupiter, Kuru Flow) is not answering. " +
      'Without it such a pair is refused and pointed at POST /v1/swaps. ' +
      'Stellar has no fallback: its DEX is part of the network.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  venueFallback?: boolean;
}
