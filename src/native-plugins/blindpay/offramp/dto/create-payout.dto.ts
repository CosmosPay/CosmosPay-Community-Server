import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import {
  CHAIN_VARIANTS,
  type ChainVariant,
} from '@/native-plugins/blindpay/blindpay.constants';
import { IsRequiredForChain } from '@/native-plugins/blindpay/validators/is-required-for-chain.validator';
import { IsWalletAddressForChain } from '@/common/validators/is-wallet-address-for-chain.validator';

/**
 * Executes an offramp from a quote. For EVM the customer must have already sent
 * the quote's `approve`; for Stellar/Solana, pass the `signed_transaction`
 * returned by the authorize step. The service never signs.
 */
@ApiSchema({
  description:
    "Executes a payout quote. For `evm` the sender has already sent the quote's `approve`; for `stellar` and `solana` send the `signed_transaction` from the authorize step.",
})
export class CreatePayoutDto {
  @ApiProperty({
    example: 'qe_000000000000',
    description:
      'Id of a payout quote from `POST /v1/offramp/quotes`; a quote is paid out at most once.',
  })
  @IsString()
  quote_id!: string;

  @ApiProperty({
    example: '0x1234567890123456789012345678901234567890',
    description:
      'Sender wallet on the selected chain (EVM 0x…, Stellar G…, or Solana base58).',
  })
  @IsString()
  @IsWalletAddressForChain('chain')
  sender_wallet_address!: string;

  @ApiProperty({
    enum: CHAIN_VARIANTS,
    example: 'evm',
    description:
      'Chain family the payout is sent from: `evm`, `stellar` or `solana`.',
  })
  @IsIn(CHAIN_VARIANTS)
  chain!: ChainVariant;

  @ApiPropertyOptional({
    description:
      'Required for stellar/solana: signed transaction (Stellar XDR / Solana tx) from POST /v1/offramp/payouts/authorize. Not used for evm.',
  })
  @IsRequiredForChain('chain', ['stellar', 'solana'])
  signed_transaction?: string;
}
