import { ApiProperty, ApiSchema } from '@nestjs/swagger';

/** An unsigned EVM transaction this service built for a wallet to sign. */
@ApiSchema({
  description:
    'An unsigned EVM transaction for a wallet (or a bot holding its own key) ' +
    'to sign and send: `eth_sendTransaction` takes `to`, `data` and `value` ' +
    'as they are, on the chain `chainId` names. This service never signs it.',
})
export class P2pMarketTransactionEntity {
  @ApiProperty({
    example: 84532,
    description: 'The EIP-155 chain id the wallet must be on.',
  })
  chainId!: number;

  @ApiProperty({
    example: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    description:
      'The contract to call: the P2P market, or the token for an approval.',
  })
  to!: string;

  @ApiProperty({
    example:
      '0xa7b0e3b50000000000000000000000000000000000000000000000000000000000000007',
    description: 'The calldata, 0x-hex.',
  })
  data!: string;

  @ApiProperty({
    example: '0',
    description: 'Native coin to send with it: always 0.',
  })
  value!: string;

  @ApiProperty({
    example: 'Release order 7: pays its buyer 98.5 USDC',
    description:
      'What signing it does, in one line, for a confirmation screen.',
  })
  description!: string;
}
