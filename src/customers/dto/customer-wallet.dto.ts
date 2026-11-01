import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CHAINS, type Chain } from '@/chains/chains.constants';
import { IsChainAddress } from '@/common/validators/is-chain-address.validator';
import { CUSTOMER_WALLET_LABEL_MAX } from '@/customers/customers.constants';

/** One wallet of a customer: the chain it is on and its address there. */
@ApiSchema({
  description:
    'One wallet of a customer: the chain it is on and its address there.',
})
export class CustomerWalletDto {
  @ApiProperty({
    enum: CHAINS,
    example: 'solana',
    description: 'The chain the wallet is on.',
  })
  @IsIn(CHAINS)
  chain!: Chain;

  @ApiProperty({
    example: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV',
    description:
      'The address on that chain: a Stellar account (G..., checksum verified), a Solana address ' +
      '(base58, 32 bytes) or a Monad address (0x + 40 hex, any case; stored EIP-55 checksummed). ' +
      'Payment intents whose payer (`source`) is this address count toward the customer.',
  })
  @IsChainAddress('chain')
  address!: string;

  @ApiPropertyOptional({
    example: 'Phantom',
    description: 'A name for the wallet, shown beside the address.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(CUSTOMER_WALLET_LABEL_MAX)
  label?: string;
}
