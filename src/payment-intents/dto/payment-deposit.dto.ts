import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { IsIn, IsString, Length } from 'class-validator';
import {
  CROSS_CHAIN_NETWORK_IDS,
  type CrossChainNetworkId,
} from '@/cross-chain-swaps/cross-chain-swaps.constants';
import { IsCrossChainAddress } from '@/cross-chain-swaps/is-cross-chain-address.validator';

/**
 * What a payer pays a payment link with, from any network: the asset they
 * send and where a refund goes. The quote and the deposit take the same three
 * fields, so the deposit made is the one the payer was quoted.
 */
@ApiSchema({
  description:
    'How a payer pays a payment link from any network: the asset sent and the ' +
    'address a refund goes to, on that network.',
})
export class PaymentDepositRequestDto {
  @ApiProperty({
    enum: CROSS_CHAIN_NETWORK_IDS,
    example: 'tron',
    description:
      'The network the payer sends from: a `chain` from ' +
      '`GET /v1/payment-links/{id}/deposit-assets`.',
  })
  @IsIn(CROSS_CHAIN_NETWORK_IDS)
  originChain!: CrossChainNetworkId;

  @ApiProperty({
    description:
      'The asset sent: "native" or the native ticker (TRX, ETH, BTC), a symbol ' +
      'listed once on that network (USDT), its contract, or Stellar ' +
      'CODE:ISSUER. See `GET /v1/payment-links/{id}/deposit-assets`.',
    example: 'USDT',
  })
  @IsString()
  @Length(1, 128)
  originAsset!: string;

  @ApiProperty({
    description:
      'Where the deposit is refunded if the payment cannot complete (or the ' +
      'surplus of an overpayment), on originChain: normally the paying wallet.',
    example: 'TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy',
  })
  @IsCrossChainAddress('originChain')
  refundTo!: string;
}
