import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateCustomerDto {
  @ApiProperty({ example: 'Acme Inc.' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'Acme — billing' })
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
    description: 'Optional Stellar account to associate the customer with.',
  })
  @IsOptional()
  @Matches(/^G[A-Z2-7]{55}$/, {
    message: 'account must be a valid Stellar public key',
  })
  account?: string;

  @ApiPropertyOptional({ example: 'cust_001' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}
