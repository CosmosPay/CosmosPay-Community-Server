import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import { IsWalletAddressForChain } from '@/common/validators/is-wallet-address-for-chain.validator';

const AUTHORIZE_CHAINS = ['stellar', 'solana'] as const;

/**
 * Step 1 of a non-EVM offramp: asks BlindPay to build the transaction the
 * customer must sign (XDR for Stellar, serialized tx for Solana). EVM payouts
 * skip this — they sign the quote's `contract.approve` directly.
 */
@ApiSchema({
  description:
    'Step one of a Stellar or Solana payout: asks BlindPay for the transaction the sender signs.',
})
export class AuthorizePayoutDto {
  @ApiProperty({
    example: 'qe_000000000000',
    description: 'Id of a payout quote from `POST /v1/offramp/quotes`.',
  })
  @IsString()
  quote_id!: string;

  @ApiProperty({
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
    description:
      'Sender wallet on the selected chain (Stellar G… or Solana base58).',
  })
  @IsString()
  @IsWalletAddressForChain('chain')
  sender_wallet_address!: string;

  @ApiProperty({
    enum: AUTHORIZE_CHAINS,
    example: 'stellar',
    description:
      'Chain the payout is sent from: `stellar` or `solana` (EVM payouts skip this step).',
  })
  @IsIn(AUTHORIZE_CHAINS)
  chain!: (typeof AUTHORIZE_CHAINS)[number];
}
