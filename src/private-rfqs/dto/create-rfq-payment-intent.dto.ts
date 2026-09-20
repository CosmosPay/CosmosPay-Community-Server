import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { IsStellarAddress } from '@/common/validators/is-stellar-address.validator';

export class CreateRfqPaymentIntentDto {
  @ApiProperty({ enum: ['TX', 'PAY'], example: 'TX' })
  @IsIn(['TX', 'PAY'])
  kind!: 'TX' | 'PAY';

  @ApiPropertyOptional({
    description: 'Required for TX; omitted for a SEP-7 pay link.',
  })
  @ValidateIf((dto: CreateRfqPaymentIntentDto) => dto.kind === 'TX')
  @IsStellarAddress()
  source?: string;

  @ApiPropertyOptional({ description: 'SEP-7 message shown by the wallet.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  msg?: string;

  @ApiPropertyOptional({ description: 'SEP-7 callback URL descriptor.' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  callback?: string;
}
