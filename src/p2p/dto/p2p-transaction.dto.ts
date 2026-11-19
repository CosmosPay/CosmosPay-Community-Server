import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { P2P_CURRENCY_CODES, P2P_TEXT_MAX } from '@/p2p/p2p.constants';
import { P2P_NETWORK_IDS } from '@/p2p/p2p-networks';
import { P2P_TRANSACTION_ACTIONS } from '@/p2p/p2p-transaction-actions';

@ApiSchema({
  description:
    'A transaction to build for a wallet: what to do, from which wallet, with which arguments. See each action’s arguments in the route’s description.',
})
export class BuildP2pMarketTransactionDto {
  @ApiProperty({ enum: P2P_NETWORK_IDS, example: 'base' })
  @IsIn(P2P_NETWORK_IDS)
  network!: string;

  @ApiProperty({
    example: 'cm3p2pacc0001l70g8v5q3z2w',
    description:
      'The wallet that signs: one of your account ids, or, for an action on a sale, the seller’s address on that order.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  from!: string;

  @ApiProperty({ enum: P2P_TRANSACTION_ACTIONS, example: 'release' })
  @IsIn(P2P_TRANSACTION_ACTIONS)
  action!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { orderId: '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10' },
  })
  @IsOptional()
  @IsObject()
  args?: Record<string, unknown>;
}

@ApiSchema({
  description:
    'An incoming bank transfer as your bank notified it: the orders it most likely settles come back with their release ready.',
})
export class P2pMarketTransferMatchesDto {
  @ApiProperty({ enum: P2P_CURRENCY_CODES, example: 'ARS' })
  @IsIn(P2P_CURRENCY_CODES)
  currency!: string;

  @ApiProperty({
    example: '125050.00',
    description: 'The amount received, local money.',
  })
  @Matches(/^\d{1,15}(\.\d{1,2})?$/, {
    message: 'amount must be a positive decimal',
  })
  amount!: string;

  @ApiPropertyOptional({ example: 'Juan Gómez', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  payerName?: string;

  @ApiPropertyOptional({ example: '20123456786', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  payerDocument?: string;

  @ApiPropertyOptional({ example: 'TRX-88213', maxLength: P2P_TEXT_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(P2P_TEXT_MAX)
  reference?: string;

  @ApiPropertyOptional({
    example: '2026-11-19T12:12:40.000Z',
    description:
      'When the bank received it: orders created after it are left out.',
  })
  @IsOptional()
  @IsDateString()
  receivedAt?: string;
}
