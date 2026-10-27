import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import type { StellarNetwork } from '@/config/configuration';

export class ZkCheckoutConfigQueryDto {
  @ApiProperty({
    enum: ['testnet', 'public'],
    example: 'testnet',
    description:
      'The network to describe. Named by the caller, since a keyless page has ' +
      'no API key to take it from.',
  })
  @IsIn(['testnet', 'public'])
  network!: StellarNetwork;
}
