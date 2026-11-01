import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsAnyChainAddress } from '@/common/validators/is-any-chain-address.validator';
import { MAX_CUSTOMER_WALLETS } from '@/customers/customers.constants';
import { CustomerWalletDto } from '@/customers/dto/customer-wallet.dto';

@ApiSchema({
  description:
    "A customer to create: a merchant-managed record whose wallets' payments count toward it.",
})
export class CreateCustomerDto {
  @ApiProperty({
    example: 'Acme Inc.',
    description: 'Customer name (1 to 120 characters).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    example: 'Acme (billing)',
    description: 'An alternative display name (at most 120 characters).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  alias?: string;

  @ApiPropertyOptional({
    example: 'VIP customer, net-30 terms.',
    description: 'Free-text note about the customer (at most 500 characters).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    example: 'billing@acme.com',
    description: 'Contact email address (at most 160 characters).',
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  email?: string;

  @ApiPropertyOptional({
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
    deprecated: true,
    description:
      'Deprecated: use `wallets`. One wallet, its chain read from its shape: a Stellar ' +
      'account (G..., checksum verified), a Solana address (base58, 32 bytes) or a Monad ' +
      'address (0x + 40 hex, any case; stored EIP-55 checksummed). It is added to `wallets`.',
  })
  @IsOptional()
  @IsAnyChainAddress()
  account?: string;

  @ApiPropertyOptional({
    type: [CustomerWalletDto],
    description:
      `The customer's wallets, on any chain payments settle on, up to ${MAX_CUSTOMER_WALLETS}. ` +
      'Payment intents paid from any of them count toward the customer. A wallet belongs to ' +
      'one customer: one that another customer of yours already holds answers ' +
      '`409 customer_wallet_taken`.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CUSTOMER_WALLETS)
  @ValidateNested({ each: true })
  @Type(() => CustomerWalletDto)
  wallets?: CustomerWalletDto[];

  @ApiPropertyOptional({
    example: 'cust_001',
    description:
      'Your own reference for the customer (at most 120 characters).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}
