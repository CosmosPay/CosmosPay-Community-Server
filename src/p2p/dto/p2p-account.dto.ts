import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { P2P_TEXT_MAX } from '@/p2p/p2p.constants';

export const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const EVM_ADDRESS_MESSAGE = 'must be an EVM address (0x + 40 hex)';

@ApiSchema({ description: 'The wallet a registration challenge is for.' })
export class CreateP2pMarketChallengeDto {
  @ApiProperty({
    example: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    description:
      'The EVM wallet to register. The same address on every network.',
  })
  @Matches(EVM_ADDRESS_PATTERN, { message: `address ${EVM_ADDRESS_MESSAGE}` })
  address!: string;
}

@ApiSchema({
  description:
    'A wallet’s registration: the address, and its EIP-191 signature over the challenge’s message.',
})
export class RegisterP2pMarketAccountDto {
  @ApiProperty({ example: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' })
  @Matches(EVM_ADDRESS_PATTERN, { message: `address ${EVM_ADDRESS_MESSAGE}` })
  address!: string;

  @ApiProperty({
    example: `0x${'1b'.repeat(65)}`,
    description:
      '`personal_sign` of the challenge message by the wallet: 65 bytes, 0x-hex.',
  })
  @IsString()
  @Matches(/^0x[0-9a-fA-F]{130}$/, {
    message: 'signature must be 65 bytes of 0x-hex',
  })
  signature!: string;

  @ApiPropertyOptional({ example: 'Treasury wallet', maxLength: P2P_TEXT_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(P2P_TEXT_MAX)
  label?: string;

  @ApiPropertyOptional({
    example: 'Pampa Cambio',
    description:
      'The name people see on quotes when this account is a merchant.',
    minLength: 2,
    maxLength: 40,
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  displayName?: string;
}

@ApiSchema({ description: 'What an account owner may change.' })
export class UpdateP2pMarketAccountDto {
  @ApiPropertyOptional({ example: 'Treasury wallet', maxLength: P2P_TEXT_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(P2P_TEXT_MAX)
  label?: string;

  @ApiPropertyOptional({ example: 'Pampa Cambio', minLength: 2, maxLength: 40 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  displayName?: string;

  @ApiPropertyOptional({
    enum: ['ACTIVE', 'PAUSED'],
    example: 'PAUSED',
    description:
      'PAUSED stops new orders from matching this merchant; its live orders go on. A SUSPENDED account cannot change this.',
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'PAUSED'])
  merchantStatus?: 'ACTIVE' | 'PAUSED';
}
