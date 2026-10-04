import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A BlindPay payout quote. Pass-through (not persisted). For EVM, `contract`
 * holds the ERC-20 `approve` the customer signs before creating the payout.
 */
export class PayoutQuoteEntity {
  @ApiProperty({ example: 'qe_000000000000' })
  id!: string;

  @ApiProperty({
    example: 1782692400,
    description: 'Unix expiry (~5 min out).',
  })
  expires_at!: number;

  @ApiPropertyOptional({ example: 10000 })
  sender_amount?: number;

  @ApiPropertyOptional({
    example: 156129400,
    description: 'Local fiat amount to receive, minor units (e.g. ARS cents).',
  })
  receiver_amount?: number;

  @ApiPropertyOptional({
    example: 156129400,
    description:
      'Local fiat amount (minor units). Normalized from `receiver_amount` when BlindPay returns 0 here.',
  })
  receiver_local_amount?: number;

  @ApiPropertyOptional({
    description:
      'EVM approve payload to sign (abi, address, functionName, amount, network).',
    example: {
      abi: [],
      address: '0xToken...',
      functionName: 'approve',
      blindpayContractAddress: '0xBlindPay...',
      amount: '10000',
      network: { name: 'base', chainId: 8453 },
    },
  })
  contract?: unknown;
}
