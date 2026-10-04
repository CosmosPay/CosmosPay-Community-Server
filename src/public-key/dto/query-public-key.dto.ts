import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export class QueryPublicKeyDto {
  @ApiPropertyOptional({
    enum: ['dev', 'prod'],
    default: 'dev',
    description: '`dev` is the testnet key, `prod` the public-network one.',
  })
  @IsOptional()
  @IsIn(['dev', 'prod'])
  env: 'dev' | 'prod' = 'dev';
}
