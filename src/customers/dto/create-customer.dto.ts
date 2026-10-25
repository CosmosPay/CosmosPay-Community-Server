import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsAnyChainAddress } from '@/common/validators/is-any-chain-address.validator';

export class CreateCustomerDto {
  @ApiProperty({ example: 'Acme Inc.' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'Acme (billing)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  alias?: string;

  @ApiPropertyOptional({ example: 'VIP customer, net-30 terms.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ example: 'billing@acme.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  email?: string;

  @ApiPropertyOptional({
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
    description:
      'Optional account to associate the customer with, on any chain: a Stellar account ' +
      '(G..., checksum verified), a Solana address (base58, 32 bytes) or a Monad address ' +
      '(0x + 40 hex, any case; stored EIP-55 checksummed). Payment intents whose payer ' +
      '(`source`) is this account count toward the customer, whatever their chain.',
  })
  @IsOptional()
  @IsAnyChainAddress()
  account?: string;

  @ApiPropertyOptional({ example: 'cust_001' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}
