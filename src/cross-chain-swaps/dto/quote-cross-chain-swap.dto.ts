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
  ValidateNested,
} from 'class-validator';
import { MerchantFeeDto } from '@/common/merchant-fee/merchant-fee.dto';
import { IsDecimalAmount } from '@/common/validators/is-decimal-amount.validator';
import {
  CROSS_CHAIN_NETWORK_IDS,
  type CrossChainNetworkId,
} from '@/cross-chain-swaps/cross-chain-swaps.constants';
import { IsCrossChainAddress } from '@/cross-chain-swaps/is-cross-chain-address.validator';

/**
 * A cross-chain swap request: sell `amount` of `originAsset` on `originChain`,
 * receive `destinationAsset` on `destinationChain` at `recipient`. NEAR Intents
 * prices it; a failed swap refunds `refundTo` on the origin chain.
 *
 * Both legs on Stellar, Solana or Monad is refused: `POST /v1/swaps` settles it
 * on that chain's own venue (the Stellar DEX, Jupiter, Kuru Flow). On every
 * other network NEAR Intents may swap within the one chain.
 */
export class QuoteCrossChainSwapDto {
  @ApiProperty({
    enum: CROSS_CHAIN_NETWORK_IDS,
    example: 'stellar',
    description:
      'The network the payer deposits on: a `chain` from ' +
      'GET /v1/cross-chain-swaps/assets.',
  })
  @IsIn(CROSS_CHAIN_NETWORK_IDS)
  originChain!: CrossChainNetworkId;

  @ApiProperty({
    description:
      'The asset sold: "native" or the native ticker (XLM, SOL, ETH, BTC), a ' +
      'symbol listed once on the chain (USDC), a contract (SPL mint, ERC-20 ' +
      'address, Stellar issuer, ...) or Stellar CODE:ISSUER. See ' +
      'GET /v1/cross-chain-swaps/assets.',
    example: 'XLM',
  })
  @IsString()
  @Length(1, 128)
  originAsset!: string;

  @ApiProperty({
    enum: CROSS_CHAIN_NETWORK_IDS,
    example: 'solana',
    description: 'The network the recipient is paid on.',
  })
  @IsIn(CROSS_CHAIN_NETWORK_IDS)
  destinationChain!: CrossChainNetworkId;

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
  @IsCrossChainAddress('destinationChain')
  recipient!: string;

  @ApiProperty({
    description:
      'Where a failed or late deposit is refunded, on originChain: normally the paying wallet.',
    example: 'GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG',
  })
  @IsCrossChainAddress('originChain')
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
    type: MerchantFeeDto,
    description:
      'Your own fee on this swap, which NEAR Intents pays as a second app fee ' +
      'to `wallet`: a NEAR account id (named, e.g. merchant.near, or 64-hex ' +
      'implicit), credited inside NEAR Intents. App fees are whole basis ' +
      'points of the deposit, so the fee is turned into the basis points it ' +
      'amounts to, rounded down. `paidBy: recipient` takes it from `amount` ' +
      '(the deposit stays `amount`); `payer` adds it to the deposit.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MerchantFeeDto)
  merchantFee?: MerchantFeeDto;
}
