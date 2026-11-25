import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import {
  PAYMENT_NETWORKS,
  type PaymentNetwork,
} from '@/payment-intents/payment-networks';

@ApiSchema({
  description:
    'The one asset a payment link on this network is in, on the test networks: the network’s test stablecoin.',
})
export class PaymentNetworkAssetEntity {
  @ApiProperty({ example: 'USDC' })
  symbol!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    description: 'The token contract on the test network.',
  })
  contract!: string | null;

  @ApiProperty({ example: 6 })
  decimals!: number;
}

@ApiSchema({
  description:
    'A network a payment link can settle on, as the caller’s key reaches it.',
})
export class PaymentNetworkEntity {
  @ApiProperty({ enum: PAYMENT_NETWORKS, example: 'base' })
  id!: PaymentNetwork;

  @ApiProperty({ example: 'Base', description: 'The network, by name.' })
  name!: string;

  @ApiProperty({
    enum: ['public', 'testnet'],
    example: 'testnet',
    description:
      'The tier the caller’s key reaches: mainnet or the test networks.',
  })
  network!: string;

  @ApiProperty({
    example: true,
    description:
      'True when a link here is paid through a deposit address made for each ' +
      'payment (every network but Stellar, Solana, Monad and Arc).',
  })
  settlesThroughDeposits!: boolean;

  @ApiProperty({
    example: true,
    description: 'Whether a link can be created on this network with this key.',
  })
  available!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Why not, when `available` is false; null otherwise.',
  })
  reason!: string | null;

  @ApiProperty({
    type: PaymentNetworkAssetEntity,
    nullable: true,
    description:
      'On the test networks, the one asset a link paid through deposit ' +
      'addresses is in (its test stablecoin). Null where any asset goes.',
  })
  asset!: PaymentNetworkAssetEntity | null;
}

@ApiSchema({ description: 'Every network a payment link can settle on.' })
export class PaymentNetworkListEntity {
  @ApiProperty({ type: [PaymentNetworkEntity] })
  data!: PaymentNetworkEntity[];
}
